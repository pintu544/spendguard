import { ProxyAgent, setGlobalDispatcher } from "undici";

/**
 * Outbound HTTP setup for the spike CLIs.
 *
 * near-api-js talks to the RPC with the global `fetch`, which does not use a
 * proxy on its own. On networks where egress must go through a proxy (this
 * dev VM is one — direct egress is blocked, and the upstream proxy URL
 * contains characters Node's fetch cannot parse), set:
 *
 *   SPENDGUARD_PROXY=http://127.0.0.1:8888   (the local egress forwarder)
 *
 * and every fetch — including near-api-js RPC calls — is routed through it.
 * Unset on a normal network: direct connections are used.
 */
export function setupProxyFromEnv(): string | null {
  const proxy = (process.env.SPENDGUARD_PROXY ?? "").trim();
  if (!proxy) return null;
  setGlobalDispatcher(new ProxyAgent(proxy));
  return proxy;
}
