import { useEffect, useState } from "react";
import { fetchIndex } from "./api/client";
import { GraphCanvas } from "./components/GraphCanvas";
import { useStore } from "./state/store";

export default function App() {
  const { files, edges, setIndex } = useStore();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchIndex()
      .then((r) => {
        setIndex(r.files, r.edges);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [setIndex]);

  if (loading) return <Centered>Loading…</Centered>;
  if (error) return <Centered>{`Error: ${error}`}</Centered>;
  if (files.length === 0)
    return <Centered>No files indexed (check backend logs).</Centered>;

  return (
    <>
      <Banner files={files.length} edges={edges.length} />
      <GraphCanvas files={files} edges={edges} />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "monospace",
        color: "#888",
      }}
    >
      {children}
    </div>
  );
}

function Banner({ files, edges }: { files: number; edges: number }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 8,
        left: 8,
        zIndex: 10,
        padding: "4px 10px",
        background: "rgba(20,20,22,0.85)",
        color: "#eee",
        font: "11px/1.4 ui-monospace, JetBrains Mono, monospace",
        border: "1px solid #333",
        borderRadius: 3,
      }}
    >
      observatory · {files} files · {edges} edges
    </div>
  );
}
