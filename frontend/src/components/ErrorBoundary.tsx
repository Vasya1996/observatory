import { Component, type ErrorInfo, type ReactNode } from "react";
import { useStore } from "../state/store";

interface Props {
  /** Label shown in the fallback header, e.g. "Explorer" or "Editor". */
  label: string;
  children: ReactNode;
  /** Called when the boundary catches — use to trigger side-effects in the
   *  parent (e.g. resetting editor_open so a crash doesn't re-trigger on
   *  the next cold reload). */
  onError?: (error: Error) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info.componentStack);
    this.props.onError?.(error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          padding: "16px 20px",
          background: "var(--paper-faint, #18181e)",
          borderLeft: "3px solid var(--amber, #f0a83a)",
          color: "var(--ink, #e8e4d8)",
          fontFamily: '"IBM Plex Sans", sans-serif',
          fontSize: "13px",
          lineHeight: "1.55",
          maxWidth: "480px",
          margin: "16px",
          borderRadius: "4px",
        }}
      >
        <div
          style={{
            fontWeight: 600,
            color: "var(--amber, #f0a83a)",
            marginBottom: "6px",
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          {this.props.label} panel crashed
        </div>
        <div style={{ marginBottom: "12px", color: "var(--ink-dim, #b9b4a6)" }}>
          This panel crashed. Reload the page to recover.
          {" "}(Error: {error.message})
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            background: "transparent",
            border: "1px solid var(--amber, #f0a83a)",
            color: "var(--amber, #f0a83a)",
            padding: "5px 14px",
            borderRadius: "3px",
            cursor: "pointer",
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: "12px",
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}

// Thin functional wrapper for the EditorPanel boundary.
// When EditorPanel crashes, we also force editor_open to false in the store
// so the next cold reload doesn't re-trigger the same crash (Task C).
export function EditorBoundary({ children }: { children: ReactNode }) {
  const setEditorOpen = useStore((s) => s.setEditorOpen);

  function handleEditorError(_error: Error) {
    // Close the editor in the persisted store so the next reload doesn't
    // boot with editor_open: true and immediately re-crash.
    setEditorOpen(null, false);
  }

  return (
    <ErrorBoundary label="Editor" onError={handleEditorError}>
      {children}
    </ErrorBoundary>
  );
}
