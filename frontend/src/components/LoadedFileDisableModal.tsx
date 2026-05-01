/**
 * LoadedFileDisableModal — confirmation dialog before disabling a loaded file
 * in the CrossCwdPanel "Also loaded for this folder" list.
 *
 * Two text variants driven by category:
 *   claude_md / rules → cwd-scoped warning (affects only the active folder)
 *   import            → global warning (affects ALL projects, file is @-imported)
 *
 * Behaviour:
 *   - "Отключить" / "Отключить глобально" → calls onConfirm()
 *   - "Отмена" / Esc / veil click → calls onCancel()
 */

import { useEffect, useRef } from "react";

export type LoadedFileCategory = "claude_md" | "rules" | "import" | "auto_memory";

interface Props {
  category: LoadedFileCategory;
  filePath: string;
  containingFile: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function LoadedFileDisableModal({
  category,
  containingFile,
  onConfirm,
  onCancel,
}: Props) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmBtnRef.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isGlobal = category === "import";

  const bodyText = isGlobal ? (
    <>
      Этот файл подключён через @-импорт из CLAUDE.md
      {containingFile ? (
        <> (<code className="lfd-code">{containingFile}</code>)</>
      ) : null}. Claude Code не позволяет точечно отключать импорты для одного cwd, поэтому отключение{" "}
      <strong>затронет все проекты</strong>, не только активный cwd. При включении обратно эффект тоже глобальный.
    </>
  ) : (
    <>
      Файл больше не будет автоматически подгружаться в новых сессиях Claude Code для текущего активного cwd. Другие проекты не затронутся.
    </>
  );

  const confirmLabel = isGlobal ? "Отключить глобально" : "Отключить";

  return (
    <div
      className="modal-veil show lfd-veil"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="lfd-title"
    >
      <div className="modal lfd-modal">
        <div className="modal-head">
          <h3 id="lfd-title">
            {isGlobal ? (
              <>Отключить <em>глобально</em>?</>
            ) : (
              <>Отключить файл?</>
            )}
          </h3>
          <button className="x" onClick={onCancel} aria-label="Отмена">
            ×
          </button>
        </div>

        <div className="modal-body lfd-body">
          {isGlobal && (
            <div className="lfd-global-warning">
              <span className="lfd-warn-icon" aria-hidden>⚠</span>
              Глобальное действие — затронет все проекты
            </div>
          )}
          <p className="lfd-text">{bodyText}</p>
        </div>

        <div className="modal-foot">
          <div className="actions">
            <button className="btn ghost" onClick={onCancel}>
              Отмена
            </button>
            <button
              ref={confirmBtnRef}
              className="btn primary danger"
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
