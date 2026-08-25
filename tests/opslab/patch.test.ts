/**
 * PATCH 的三种语义
 *
 * 差别全在列表上：merge patch 整体替换，strategic merge 按 merge key 逐项合并。
 * `kubectl set image` 只换镜像而不把别的容器删掉，靠的就是后者。
 */
import {
  applyJsonPatch, applyMergePatch, applyPatch, applyStrategicMergePatch,
} from '../../src/lib/opslab/apiserver/patch';

const POD_SPEC = {
  spec: {
    containers: [
      { name: 'app', image: 'app:1.0', ports: [{ containerPort: 8080, name: 'http' }] },
      { name: 'sidecar', image: 'proxy:2.0' },
    ],
    volumes: [{ name: 'data', emptyDir: {} }],
    tolerations: [{ key: 'a' }],
  },
};

describe('RFC 6902 json patch', () => {
  it('add / replace / remove', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }])).toEqual({ a: 1, b: 2 });
    expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 9 }])).toEqual({ a: 9 });
    expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }])).toEqual({ a: 1 });
  });

  it('数组下标与末尾追加', () => {
    expect(applyJsonPatch({ xs: [1, 2] }, [{ op: 'add', path: '/xs/-', value: 3 }])).toEqual({ xs: [1, 2, 3] });
    expect(applyJsonPatch({ xs: [1, 2] }, [{ op: 'add', path: '/xs/0', value: 0 }])).toEqual({ xs: [0, 1, 2] });
    expect(applyJsonPatch({ xs: [1, 2] }, [{ op: 'remove', path: '/xs/0' }])).toEqual({ xs: [2] });
  });

  it('replace 不存在的路径要报错，不能悄悄新建', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/nope', value: 1 }])).toThrow();
  });

  it('test 不通过就整条失败', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }])).toThrow();
    expect(applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 1 }])).toEqual({ a: 1 });
  });

  it('转义的 pointer（~1 是 /，~0 是 ~）', () => {
    const target = { 'a/b': 1, 'c~d': 2 };
    expect(applyJsonPatch(target, [{ op: 'replace', path: '/a~1b', value: 9 }])).toMatchObject({ 'a/b': 9 });
    expect(applyJsonPatch(target, [{ op: 'replace', path: '/c~0d', value: 9 }])).toMatchObject({ 'c~d': 9 });
  });

  it('kubectl patch --type=json 常用的那种路径', () => {
    const patched = applyJsonPatch(POD_SPEC, [
      { op: 'replace', path: '/spec/containers/0/image', value: 'app:2.0' },
    ]) as typeof POD_SPEC;
    expect(patched.spec.containers[0].image).toBe('app:2.0');
    expect(patched.spec.containers[1].image).toBe('proxy:2.0');
  });
});

describe('RFC 7386 merge patch', () => {
  it('递归合并对象，null 删键', () => {
    expect(applyMergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } }))
      .toEqual({ a: 1, b: { c: 9, d: 3 } });
    expect(applyMergePatch({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
  });

  it('列表整体替换 —— 这正是它和策略合并的分水岭', () => {
    const patched = applyMergePatch(POD_SPEC, {
      spec: { containers: [{ name: 'app', image: 'app:2.0' }] },
    }) as typeof POD_SPEC;
    expect(patched.spec.containers).toHaveLength(1);
  });
});

describe('策略合并', () => {
  it('containers 按 name 合并，其它容器留着', () => {
    const patched = applyStrategicMergePatch(POD_SPEC, {
      spec: { containers: [{ name: 'app', image: 'app:2.0' }] },
    }) as typeof POD_SPEC;

    expect(patched.spec.containers).toHaveLength(2);
    expect(patched.spec.containers[0]).toEqual({
      name: 'app', image: 'app:2.0', ports: [{ containerPort: 8080, name: 'http' }],
    });
    expect(patched.spec.containers[1].image).toBe('proxy:2.0');
  });

  it('嵌套列表也按各自的 merge key 合并（ports 用 containerPort）', () => {
    const patched = applyStrategicMergePatch(POD_SPEC, {
      spec: { containers: [{ name: 'app', ports: [{ containerPort: 9090, name: 'metrics' }] }] },
    }) as typeof POD_SPEC;
    expect(patched.spec.containers[0].ports).toEqual([
      { containerPort: 8080, name: 'http' },
      { containerPort: 9090, name: 'metrics' },
    ]);
  });

  it('没有 merge key 的列表整体替换（tolerations、command 都是这样）', () => {
    const patched = applyStrategicMergePatch(POD_SPEC, {
      spec: { tolerations: [{ key: 'b' }] },
    }) as typeof POD_SPEC;
    expect(patched.spec.tolerations).toEqual([{ key: 'b' }]);
  });

  it('$patch: delete 删掉列表里的一项', () => {
    const patched = applyStrategicMergePatch(POD_SPEC, {
      spec: { containers: [{ name: 'sidecar', $patch: 'delete' }] },
    }) as typeof POD_SPEC;
    expect(patched.spec.containers.map((c) => c.name)).toEqual(['app']);
  });

  it('$patch: replace 强制整体替换', () => {
    const patched = applyStrategicMergePatch(POD_SPEC, {
      spec: { containers: [{ name: 'only' }], $patch: 'replace' },
    }) as { spec: { containers: Array<{ name: string }>; volumes?: unknown } };
    expect(patched.spec.containers).toEqual([{ name: 'only' }]);
    expect(patched.spec.volumes).toBeUndefined();
  });

  it('null 删键；$setElementOrder 只是排序提示，忽略掉', () => {
    const patched = applyStrategicMergePatch(POD_SPEC, {
      spec: { volumes: null, '$setElementOrder/containers': [{ name: 'sidecar' }, { name: 'app' }] },
    }) as { spec: Record<string, unknown> };
    expect(patched.spec.volumes).toBeUndefined();
    expect(patched.spec['$setElementOrder/containers']).toBeUndefined();
  });

  it('finalizers 这种字符串列表按值合并，不重复', () => {
    const patched = applyStrategicMergePatch(
      { metadata: { finalizers: ['a'] } },
      { metadata: { finalizers: ['a', 'b'] } }
    ) as { metadata: { finalizers: string[] } };
    expect(patched.metadata.finalizers).toEqual(['a', 'b']);
  });

  it('不改原对象', () => {
    const before = JSON.stringify(POD_SPEC);
    applyStrategicMergePatch(POD_SPEC, { spec: { containers: [{ name: 'app', image: 'x' }] } });
    expect(JSON.stringify(POD_SPEC)).toBe(before);
  });
});

describe('按 content-type 分发', () => {
  it('三种都认', () => {
    expect(applyPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }], 'application/json-patch+json'))
      .toEqual({ a: 2 });
    expect(applyPatch({ a: 1, b: 2 }, { b: null }, 'application/merge-patch+json')).toEqual({ a: 1 });
    expect(applyPatch(POD_SPEC, { spec: { containers: [{ name: 'app', image: 'z' }] } },
      'application/strategic-merge-patch+json') as typeof POD_SPEC).toMatchObject({
      spec: { containers: [{ name: 'app', image: 'z' }, { name: 'sidecar' }] },
    });
  });

  it('服务端 apply 明确不支持，而不是装作支持了', () => {
    expect(() => applyPatch({}, {}, 'application/apply-patch+yaml'))
      .toThrow(/server-side apply is not supported/);
  });
});
