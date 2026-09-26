import { useCallback, useEffect, useState } from "react";
import { fetchBridgeHealth, type BridgeHealth } from "@/providers/claudeCode";

/**
 * In place of an API key field: whether the Claude Code bridge is up, and
 * whether the Claude Code behind it is signed in. Asking costs nothing — the
 * bridge answers from `claude auth status`, without calling a model — so it is
 * asked on open and on demand. Each state says the one thing to do next.
 */
export function BridgeStatus({ baseUrl }: { baseUrl: string }) {
  const [health, setHealth] = useState<BridgeHealth | null | "checking">("checking");

  const check = useCallback(async () => {
    setHealth("checking");
    setHealth(await fetchBridgeHealth(baseUrl));
  }, [baseUrl]);

  useEffect(() => {
    void check();
  }, [check]);

  let tone = "warn";
  let message: React.ReactNode;
  if (health === "checking") {
    tone = "idle";
    message = "Checking the bridge…";
  } else if (health === null) {
    message = (
      <>
        The bridge is not running. Start it in a terminal with <code>npm run bridge</code>.
      </>
    );
  } else if (!health.installed) {
    message = "The bridge is running, but Claude Code is not installed on this machine.";
  } else if (!health.loggedIn) {
    message = (
      <>
        Claude Code {health.version} is not signed in. Run <code>claude</code> once in a terminal
        and sign in with your own account.
      </>
    );
  } else {
    tone = "ok";
    message = (
      <>
        Ready — Claude Code {health.version}, signed in
        {health.subscriptionType ? ` (${health.subscriptionType}` : ""}
        {health.orgName ? `, ${health.orgName}` : ""}
        {health.subscriptionType ? ")" : ""}. No key is needed: requests use your own
        subscription and count toward its usage limits.
      </>
    );
  }

  return (
    <div className="field">
      <span className="field__label">Bridge</span>
      <div className={`bridgestatus bridgestatus--${tone}`} role="status">
        <span className="bridgestatus__dot" aria-hidden />
        <span className="bridgestatus__text">{message}</span>
        <button type="button" className="btn btn--sm" onClick={() => void check()}>
          check again
        </button>
      </div>
    </div>
  );
}
