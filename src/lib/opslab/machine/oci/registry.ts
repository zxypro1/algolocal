/**
 * 本地镜像库与远端 registry
 *
 * 报错文本是这一层的重点。`ImagePullBackOff` 的排查全靠这几句话：
 * 401 是没登录、403 是没权限、no such host 是名字解析不了、
 * manifest unknown 是 tag 打错了 —— 学员要能从文本分辨出是哪一种。
 */
import { Image, parseReference } from './image';
import { manifestDigest } from './image';
import { shortId } from './digest';

export class RegistryError extends Error {
  constructor(message: string, readonly kind: 'unauthorized' | 'denied' | 'not-found' | 'network') {
    super(message);
    this.name = 'RegistryError';
  }
}

export interface Credentials {
  username: string;
  password: string;
}

/* ------------------------------------------------------------------ */
/* 本地镜像库（相当于 dockerd 的 image store）                          */
/* ------------------------------------------------------------------ */

export class ImageStore {
  private byId = new Map<string, Image>();

  add(image: Image): Image {
    const existing = this.byId.get(image.id);
    if (existing) {
      // 同一个镜像被打了新 tag
      const repoTags = [...new Set([...existing.repoTags, ...image.repoTags])].sort();
      const merged = { ...existing, repoTags };
      this.byId.set(image.id, merged);
      return merged;
    }
    this.byId.set(image.id, { ...image, repoTags: [...image.repoTags].sort() });
    return this.byId.get(image.id)!;
  }

  /** 按 tag、完整 id 或短 id 找 */
  get(reference: string): Image | undefined {
    if (this.byId.has(reference)) return this.byId.get(reference);
    const canonical = parseReference(reference).canonical;
    for (const image of this.byId.values()) {
      if (image.repoTags.includes(canonical)) return image;
      if (shortId(image.id) === reference) return image;
    }
    return undefined;
  }

  tag(source: string, target: string): Image {
    const image = this.get(source);
    if (!image) throw new RegistryError(`Error response from daemon: No such image: ${source}`, 'not-found');
    const canonical = parseReference(target).canonical;
    return this.add({ ...image, repoTags: [...image.repoTags, canonical] });
  }

  /** 删一个 tag；最后一个 tag 没了才真删镜像 */
  remove(reference: string): { untagged?: string; deleted?: string } {
    const image = this.get(reference);
    if (!image) throw new RegistryError(`Error response from daemon: No such image: ${reference}`, 'not-found');

    const canonical = parseReference(reference).canonical;
    const remaining = image.repoTags.filter((tag) => tag !== canonical);
    if (remaining.length > 0 && remaining.length !== image.repoTags.length) {
      this.byId.set(image.id, { ...image, repoTags: remaining });
      return { untagged: canonical };
    }
    this.byId.delete(image.id);
    return { untagged: image.repoTags[0], deleted: image.id };
  }

  /** 新的在前，和 `docker images` 一样 */
  list(): Image[] {
    return [...this.byId.values()].sort((a, b) =>
      a.created === b.created ? (a.id < b.id ? 1 : -1) : a.created < b.created ? 1 : -1
    );
  }
}

/* ------------------------------------------------------------------ */
/* 远端 registry                                                       */
/* ------------------------------------------------------------------ */

export interface RegistryOptions {
  host: string;
  /** 用户名 -> 密码。空表示不需要认证。 */
  users?: Record<string, string>;
  /** 允许推送到哪些项目（第一段路径）。不填表示都能推。 */
  projects?: string[];
  /** 匿名能不能拉 */
  anonymousPull?: boolean;
  /** 预置的镜像，`repository:tag -> Image` */
  seed?: Record<string, Image>;
}

export class Registry {
  readonly host: string;
  private readonly users: Record<string, string>;
  private readonly projects?: string[];
  private readonly anonymousPull: boolean;
  /** repository -> tag -> Image */
  private repositories = new Map<string, Map<string, Image>>();

  constructor(options: RegistryOptions) {
    this.host = options.host;
    this.users = options.users ?? {};
    this.projects = options.projects;
    this.anonymousPull = options.anonymousPull ?? Object.keys(options.users ?? {}).length === 0;
    for (const [reference, image] of Object.entries(options.seed ?? {})) {
      const parsed = parseReference(`${this.host}/${reference}`);
      this.put(parsed.repository, parsed.tag, image);
    }
  }

  private put(repository: string, tag: string, image: Image): void {
    const tags = this.repositories.get(repository) ?? new Map<string, Image>();
    tags.set(tag, image);
    this.repositories.set(repository, tags);
  }

  private requiresAuth(): boolean {
    return Object.keys(this.users).length > 0;
  }

  authenticate(credentials?: Credentials): boolean {
    if (!this.requiresAuth()) return true;
    if (!credentials) return false;
    return this.users[credentials.username] === credentials.password;
  }

  push(reference: string, image: Image, credentials?: Credentials): { digest: string } {
    const parsed = parseReference(reference);
    if (this.requiresAuth() && !this.authenticate(credentials)) {
      // 没登录和登录了但密码/权限不对，是两种要分开查的故障
      throw credentials
        ? new RegistryError(`denied: requested access to the resource is denied`, 'denied')
        : new RegistryError(`unauthorized: authentication required`, 'unauthorized');
    }
    const project = parsed.repository.split('/')[0];
    if (this.projects && !this.projects.includes(project)) {
      throw new RegistryError(
        `denied: requested access to the resource is denied`,
        'denied'
      );
    }
    this.put(parsed.repository, parsed.tag, image);
    return { digest: manifestDigest(image) };
  }

  pull(reference: string, credentials?: Credentials): Image {
    const parsed = parseReference(reference);
    if (!this.anonymousPull && !this.authenticate(credentials)) {
      throw new RegistryError(
        credentials
          ? `pull access denied for ${parsed.registry}/${parsed.repository}, repository does not exist or may require 'docker login'`
          : `unauthorized: authentication required`,
        credentials ? 'denied' : 'unauthorized'
      );
    }
    const tags = this.repositories.get(parsed.repository);
    if (!tags) {
      throw new RegistryError(
        `pull access denied for ${parsed.registry}/${parsed.repository}, repository does not exist or may require 'docker login'`,
        'not-found'
      );
    }
    const image = tags.get(parsed.tag);
    if (!image) {
      throw new RegistryError(`manifest for ${parsed.canonical} not found: manifest unknown`, 'not-found');
    }
    return { ...image, repoTags: [parsed.canonical] };
  }

  listTags(repository: string): string[] {
    return [...(this.repositories.get(repository)?.keys() ?? [])].sort();
  }

  catalog(): string[] {
    return [...this.repositories.keys()].sort();
  }
}

/* ------------------------------------------------------------------ */
/* 网络：谁能解析到哪个 registry                                        */
/* ------------------------------------------------------------------ */

export class RegistryNetwork {
  private hosts = new Map<string, Registry>();

  add(registry: Registry): void {
    this.hosts.set(registry.host, registry);
  }

  /** 解析不了的主机名要长得像真的 DNS 失败，这是最常见的一类故障 */
  resolve(host: string): Registry {
    const registry = this.hosts.get(host);
    if (!registry) {
      throw new RegistryError(
        `Get "https://${host}/v2/": dial tcp: lookup ${host}: no such host`,
        'network'
      );
    }
    return registry;
  }

  has(host: string): boolean {
    return this.hosts.has(host);
  }
}
