// The sheet a page's HTTP Basic Auth challenge opens over the browser pane (DESIGN.md "Browser").
// The service keeps what is typed in memory only and never echoes it back; every viewer's sheet
// closes when one answers (BrowserState.auth clears).

import { useState } from "react";
import type { BrowserAuth } from "@harness/shared";
import { Modal } from "../components/bits";

export function BrowserAuthSheet({ auth, onSubmit, onCancel }: { auth: BrowserAuth; onSubmit: (username: string, password: string) => void; onCancel: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const plain = auth.origin.startsWith("http:");
  return (
    <Modal onClose={onCancel} width={400}>
      <form
        data-testid="browser-auth"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(username, password);
        }}
      >
        <div className="modal-head">
          <strong>Sign in to {auth.origin}</strong>
        </div>
        <div className="modal-body">
          {auth.realm && <p className="dim" style={{ margin: "0 0 12px" }}>“{auth.realm}”</p>}
          {auth.failed && (
            <p data-testid="browser-auth-failed" style={{ margin: "0 0 12px", color: "var(--red)" }}>
              Incorrect username or password.
            </p>
          )}
          <div className="field">
            <label htmlFor="browser-auth-user">Username</label>
            <input id="browser-auth-user" className="input" autoFocus autoComplete="off" autoCapitalize="off" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="browser-auth-pass">Password</label>
            <input id="browser-auth-pass" className="input" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          {plain && (
            <p className="field-hint" data-testid="browser-auth-plain" style={{ margin: 0 }}>
              This site isn't encrypted (http:): the password is sent in the clear.
            </p>
          )}
        </div>
        <div className="modal-foot">
          <div className="grow" />
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!username}>
            Sign in
          </button>
        </div>
      </form>
    </Modal>
  );
}
