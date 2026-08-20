/**
 * 云端状态
 *
 * 这个 Provider 包住了整个应用，所以它有一条硬性约束：**挂载时不发任何请求**。
 * 题目列表、编辑器、工程实战这些主链路页面必须在完全没有网络的机器上和现在
 * 一模一样地工作，一个挂在根节点上的健康检查足以毁掉这一点 —— 它会占着连接、
 * 拖慢首屏，在断网时还要等到超时。
 *
 * 探测是懒的：市场页、账号页这类真正需要云端的界面自己调 ensureProbe()。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as api from '../lib/cloud/api';
import { CloudError } from '../lib/cloud/client';
import { isCloudEnabled } from '../lib/cloud/config';
import {
  clearSession,
  getSession,
  setSession,
  subscribeSession,
  type StoredSession,
} from '../lib/cloud/session';
import type { CloudHealth, CloudUser } from '../lib/cloud/types';

export type CloudStatus =
  | 'idle' // 还没探测过
  | 'checking'
  | 'online'
  | 'offline' // 连不上，或者服务端说自己没配数据库
  | 'disabled'; // 用户在设置里关掉了云端功能

interface CloudContextValue {
  status: CloudStatus;
  health: CloudHealth | null;
  user: CloudUser | null;
  /** 触发一次健康探测（已经探过就直接返回结果） */
  ensureProbe: () => Promise<CloudStatus>;
  /** 忽略缓存，重新探一次。设置页改完地址后用。 */
  refresh: () => Promise<CloudStatus>;
  signIn: (input: { email: string; password: string }) => Promise<void>;
  signUp: (input: { email: string; password: string; displayName: string }) => Promise<void>;
  signOut: () => Promise<void>;
  startGithubSignIn: (redirectPath?: string) => void;
  updateUser: (user: CloudUser) => void;
}

const CloudContext = createContext<CloudContextValue | undefined>(undefined);

/** 探测结果的有效期。太短会在市场页翻页时反复探测，太长会让「刚配好」迟迟不生效。 */
const PROBE_TTL_MS = 60_000;

export function CloudProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<StoredSession | null>(null);
  const [status, setStatus] = useState<CloudStatus>('idle');
  const [health, setHealth] = useState<CloudHealth | null>(null);

  const probedAt = useRef(0);
  const inFlight = useRef<Promise<CloudStatus> | null>(null);

  // 读一次 localStorage 就够了，没有网络请求
  useEffect(() => {
    setSessionState(getSession());
    return subscribeSession(setSessionState);
  }, []);

  // GitHub 登录回跳会把 token 挂在 fragment 上，这里接住它
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash || (!hash.includes('token=') && !hash.includes('error='))) return;

    const params = new URLSearchParams(hash);
    const token = params.get('token');
    const expiresAt = params.get('expires_at');

    // 无论成功失败都先把 fragment 抹掉：token 留在地址栏里会被截图、
    // 被分享、被浏览器历史记下来
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    if (!token || !expiresAt) return;

    // 先用一个占位用户把登录态存下来，再用 token 去拿真实资料。
    // 反过来的话，请求失败就等于登录白登了。
    setSession({
      token,
      expiresAt,
      user: { id: '', email: '', displayName: '', avatarUrl: null, providers: ['github'], createdAt: '' },
    });

    api
      .fetchMe()
      .then(({ user }) => setSession({ token, expiresAt, user }))
      .catch(() => clearSession());
  }, []);

  const probe = useCallback(async (force: boolean): Promise<CloudStatus> => {
    if (!isCloudEnabled()) {
      setStatus('disabled');
      return 'disabled';
    }

    if (!force && Date.now() - probedAt.current < PROBE_TTL_MS && status !== 'idle' && status !== 'checking') {
      return status;
    }
    // 多个组件同时挂载时共用同一次探测，而不是各发一个请求
    if (inFlight.current && !force) return inFlight.current;

    setStatus('checking');

    const request = (async (): Promise<CloudStatus> => {
      try {
        const result = await api.fetchHealth();
        setHealth(result);
        probedAt.current = Date.now();
        const next: CloudStatus = result.features.database ? 'online' : 'offline';
        setStatus(next);
        return next;
      } catch (error) {
        setHealth(null);
        probedAt.current = Date.now();
        const next: CloudStatus = error instanceof CloudError && error.code === 'disabled' ? 'disabled' : 'offline';
        setStatus(next);
        return next;
      } finally {
        inFlight.current = null;
      }
    })();

    inFlight.current = request;
    return request;
  }, [status]);

  const ensureProbe = useCallback(() => probe(false), [probe]);
  const refresh = useCallback(() => probe(true), [probe]);

  const signIn = useCallback(async (input: { email: string; password: string }) => {
    const result = await api.login(input);
    setSession({ token: result.token, expiresAt: result.expiresAt, user: result.user });
  }, []);

  const signUp = useCallback(async (input: { email: string; password: string; displayName: string }) => {
    const result = await api.register(input);
    setSession({ token: result.token, expiresAt: result.expiresAt, user: result.user });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // 服务端已经不认这个 token，或者此刻没网。本地登录态照样要清掉,
      // 否则用户会卡在一个「点了退出但还显示着登录」的状态里
    }
    clearSession();
  }, []);

  const startGithubSignIn = useCallback((redirectPath = '/account') => {
    if (typeof window === 'undefined') return;
    const redirectUri = `${window.location.origin}${redirectPath}`;
    window.location.href = api.githubStartUrl(redirectUri);
  }, []);

  const updateUser = useCallback((user: CloudUser) => {
    const current = getSession();
    if (!current) return;
    setSession({ ...current, user });
  }, []);

  const value = useMemo<CloudContextValue>(
    () => ({
      status,
      health,
      user: session?.user?.id ? session.user : null,
      ensureProbe,
      refresh,
      signIn,
      signUp,
      signOut,
      startGithubSignIn,
      updateUser,
    }),
    [status, health, session, ensureProbe, refresh, signIn, signUp, signOut, startGithubSignIn, updateUser]
  );

  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}

export function useCloud(): CloudContextValue {
  const context = useContext(CloudContext);
  if (!context) throw new Error('useCloud must be used within a CloudProvider');
  return context;
}

/**
 * 进入一个需要云端的界面时调它：挂载即探测一次。
 *
 * 独立成一个 hook 而不是塞进 useCloud，是为了让「哪些页面会联网」在代码里
 * 一眼可见 —— 搜这个名字就能列全。
 */
export function useCloudSurface(): CloudContextValue {
  const cloud = useCloud();
  const { ensureProbe } = cloud;

  useEffect(() => {
    void ensureProbe();
  }, [ensureProbe]);

  return cloud;
}
