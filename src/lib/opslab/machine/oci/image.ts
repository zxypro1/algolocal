/**
 * OCI 镜像的数据结构
 *
 * 字段名照抄 OCI image-spec（大写开头的 `Env` / `Entrypoint` …），
 * 因为 `docker inspect` 与 `crictl inspecti` 打出来的就是这些名字。
 * 学员照着现实里的文档去 `jq '.Config.User'`，得能取到东西。
 */
import { digestOf } from './digest';

export interface OciImageConfig {
  User?: string;
  ExposedPorts?: Record<string, Record<string, never>>;
  Env?: string[];
  Entrypoint?: string[] | null;
  Cmd?: string[] | null;
  WorkingDir?: string;
  Labels?: Record<string, string>;
  StopSignal?: string;
  Volumes?: Record<string, Record<string, never>>;
  Healthcheck?: { Test?: string[]; Interval?: number; Timeout?: number; Retries?: number };
}

export interface HistoryEntry {
  created: string;
  created_by: string;
  /** 元数据指令不产生层 */
  empty_layer?: boolean;
}

/** 一层的内容。不做压缩，所以 digest 与 diff_id 相同。 */
export interface Layer {
  digest: string;
  size: number;
  createdBy: string;
  /** 这一层新增或改动的文件 */
  files: Record<string, string>;
  /** 这一层删掉的路径（whiteout） */
  removed: string[];
}

export interface Image {
  /** `sha256:…`，就是 config 的 digest */
  id: string;
  repoTags: string[];
  repoDigests: string[];
  config: OciImageConfig;
  layers: Layer[];
  history: HistoryEntry[];
  architecture: string;
  os: string;
  /** ISO8601 */
  created: string;
  size: number;
}

/** 层内容的规范序列化 —— 顺序固定，同样的内容必然同样的 digest */
export function layerDigest(files: Record<string, string>, removed: string[]): { digest: string; size: number } {
  const parts: string[] = [];
  for (const path of Object.keys(files).sort()) parts.push(`+${path}\0${files[path]}`);
  for (const path of [...removed].sort()) parts.push(`-${path}`);
  const payload = parts.join('\n');
  return { digest: digestOf(payload), size: payload.length };
}

export function makeLayer(files: Record<string, string>, removed: string[], createdBy: string): Layer {
  const { digest, size } = layerDigest(files, removed);
  return { digest, size, createdBy, files, removed };
}

/** OCI image config 的 JSON —— 镜像 ID 就是它的 digest */
export function imageConfigJson(image: Omit<Image, 'id' | 'repoTags' | 'repoDigests' | 'size'>): string {
  return JSON.stringify({
    architecture: image.architecture,
    os: image.os,
    created: image.created,
    config: image.config,
    rootfs: { type: 'layers', diff_ids: image.layers.map((layer) => layer.digest) },
    history: image.history,
  });
}

export function finalizeImage(
  draft: Omit<Image, 'id' | 'repoDigests' | 'size'> & { repoTags?: string[] }
): Image {
  const base = {
    config: draft.config,
    layers: draft.layers,
    history: draft.history,
    architecture: draft.architecture,
    os: draft.os,
    created: draft.created,
  };
  const json = imageConfigJson(base);
  return {
    ...base,
    id: digestOf(json),
    repoTags: draft.repoTags ?? [],
    repoDigests: [],
    size: draft.layers.reduce((total, layer) => total + layer.size, 0),
  };
}

/** OCI manifest，registry 之间传的就是它 */
export function imageManifest(image: Image): string {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: image.id,
      size: imageConfigJson(image).length,
    },
    layers: image.layers.map((layer) => ({
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: layer.digest,
      size: layer.size,
    })),
  }, null, 3);
}

/** manifest 的 digest —— `docker push` 末尾打的那个 */
export function manifestDigest(image: Image): string {
  return digestOf(imageManifest(image));
}

/** 把层一层层叠起来，得到最终的根文件系统 */
export function flattenLayers(layers: Layer[]): Record<string, string> {
  const rootfs: Record<string, string> = {};
  for (const layer of layers) {
    for (const path of layer.removed) {
      delete rootfs[path];
      // 删目录要把子树一起删掉
      const prefix = `${path}/`;
      for (const key of Object.keys(rootfs)) {
        if (key.startsWith(prefix)) delete rootfs[key];
      }
    }
    Object.assign(rootfs, layer.files);
  }
  return rootfs;
}

/* ------------------------------------------------------------------ */
/* 镜像引用                                                            */
/* ------------------------------------------------------------------ */

export interface ImageReference {
  /** `harbor.corp.internal`，没写就是 Docker Hub */
  registry: string;
  /** `team/app`，Docker Hub 上的单段名字会补 `library/` */
  repository: string;
  tag: string;
  digest?: string;
  /** 规范化之后的完整引用 */
  canonical: string;
}

const DEFAULT_REGISTRY = 'docker.io';

/**
 * 解析镜像引用。
 *
 * 判断第一段是不是 registry 的规则和 Docker 一样：含 `.` 或 `:`，
 * 或者就是 `localhost`。`nginx` → `docker.io/library/nginx:latest`。
 */
export function parseReference(reference: string): ImageReference {
  let rest = reference;
  let digest: string | undefined;

  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }

  const slash = rest.indexOf('/');
  const head = slash < 0 ? '' : rest.slice(0, slash);
  const hasRegistry = head !== '' && (head.includes('.') || head.includes(':') || head === 'localhost');
  const registry = hasRegistry ? head : DEFAULT_REGISTRY;
  let path = hasRegistry ? rest.slice(slash + 1) : rest;

  let tag = digest ? '' : 'latest';
  const colon = path.lastIndexOf(':');
  if (colon > path.lastIndexOf('/')) {
    tag = path.slice(colon + 1);
    path = path.slice(0, colon);
  }
  if (registry === DEFAULT_REGISTRY && !path.includes('/')) path = `library/${path}`;

  const canonical = digest
    ? `${registry}/${path}@${digest}`
    : `${registry}/${path}:${tag}`;
  return { registry, repository: path, tag, digest, canonical };
}

/** 学员敲进 manifest 的那种短名字，用来比对 */
export function normalizeReference(reference: string): string {
  return parseReference(reference).canonical;
}
