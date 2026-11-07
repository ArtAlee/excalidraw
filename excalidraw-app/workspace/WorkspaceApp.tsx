import { useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  reconcileElements,
  restoreElements,
} from "@excalidraw/excalidraw";
import { clearAppStateForDatabase } from "@excalidraw/excalidraw/appState";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";

import type {
  AppState,
  ExcalidrawImperativeAPI,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";

import { api, ApiError } from "./api";
import { BoardSync } from "./BoardSync";

import "./workspace.scss";

import type { Board, BoardData, Folder, Project, Workspace } from "./api";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Не удалось выполнить действие";
type User = { id: string; name: string };
type Action = {
  kind: "projects" | "folders" | "boards";
  item?: Project;
  remove?: boolean;
};

function BoardEditor({
  board,
  id,
  publicToken,
  sessionToken,
  ownerDocument,
}: {
  board: BoardData;
  id?: string;
  publicToken?: string;
  sessionToken?: string;
  ownerDocument: Document;
}) {
  const [status, setStatus] = useState("saved");
  const [error, setError] = useState("");
  const readOnly = !!publicToken;
  const basePath = sessionToken ? `/session/${sessionToken}` : `/boards/${id}`;
  const [shareUrl, setShareUrl] = useState("");
  const [sessionUrl, setSessionUrl] = useState("");
  const [sessionActive, setSessionActive] = useState(!!sessionToken);
  const [connected, setConnected] = useState(false);
  const clientId = useRef("");
  const collaborators = useRef<AppState["collaborators"]>(new Map());
  const pointer = useRef<
    Parameters<NonNullable<ExcalidrawProps["onPointerUpdate"]>>[0] | null
  >(null);
  const [shared, setShared] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [available, setAvailable] = useState(true);
  const alive = useRef(true);
  const editorAPI = useRef<ExcalidrawImperativeAPI | null>(null);
  const applying = useRef(false);
  const [queue] = useState(
    () =>
      new BoardSync(
        sessionToken ? basePath : `/boards/${id}/sync`,
        {
          elements: board.scene.elements || [],
          appState: clearAppStateForDatabase(board.scene.appState || {}),
          files: board.scene.files || {},
        },
        board.revision,
        (scene) => {
          const editor = editorAPI.current;
          if (editor && alive.current) {
            applying.current = true;
            try {
              editor.addFiles(Object.values(scene.files));
              editor.updateScene({
                elements: reconcileElements(
                  editor.getSceneElementsIncludingDeleted(),
                  restoreElements(
                    scene.elements,
                    null,
                  ) as RemoteExcalidrawElement[],
                  editor.getAppState(),
                ),
                appState: { ...editor.getAppState(), ...scene.appState },
                captureUpdate: CaptureUpdateAction.NEVER,
              });
            } finally {
              applying.current = false;
            }
          }
        },
        (state, reason) => {
          if (alive.current) {
            setStatus(state);
            setError(reason ? message(reason) : "");
            if (
              reason instanceof ApiError &&
              [401, 404].includes(reason.status)
            ) {
              setAvailable(false);
              queue.dispose();
            }
          }
        },
      ),
  );
  useEffect(() => {
    alive.current = true;
    if (!readOnly) {
      queue.start();
    }
    const ownerWindow = ownerDocument.defaultView!;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (queue.dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    ownerWindow.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive.current = false;
      queue.dispose();
      ownerWindow.removeEventListener("beforeunload", beforeUnload);
    };
  }, [queue, ownerDocument, readOnly]);
  useEffect(() => {
    if (readOnly) {
      return;
    }
    const ownerWindow = ownerDocument.defaultView!;
    const events = new ownerWindow.EventSource(`/api${basePath}/live`);
    queue.setRealtime(true);
    const updateCollaborators = () =>
      editorAPI.current?.updateScene({
        collaborators: new Map(collaborators.current),
      });
    events.addEventListener("ready", (event) => {
      const data = JSON.parse((event as MessageEvent).data);
      clientId.current = data.id;
      collaborators.current.clear();
      updateCollaborators();
      setSessionActive(data.active);
      setConnected(true);
      queue.remoteChanged();
    });
    events.addEventListener("scene", () => queue.remoteChanged());
    events.addEventListener("session", (event) => {
      const { active } = JSON.parse((event as MessageEvent).data);
      setSessionActive(active);
      collaborators.current.clear();
      updateCollaborators();
    });
    events.addEventListener("pointer", (event) => {
      const data = JSON.parse((event as MessageEvent).data);
      if (data.id !== clientId.current) {
        collaborators.current.set(data.id, {
          pointer: data.pointer,
          button: data.button,
          username: `Участник ${data.id.slice(0, 4)}`,
        });
        updateCollaborators();
      }
    });
    events.addEventListener("leave", (event) => {
      collaborators.current.delete(JSON.parse((event as MessageEvent).data).id);
      updateCollaborators();
    });
    events.addEventListener("revoked", () => {
      events.close();
      queue.dispose();
      setAvailable(false);
    });
    events.onerror = () => {
      setConnected(false);
      collaborators.current.clear();
      updateCollaborators();
    };
    return () => events.close();
  }, [basePath, ownerDocument, queue, readOnly]);
  useEffect(() => {
    if (!sessionActive || !connected || readOnly) {
      return;
    }
    let sending = false;
    const timer = setInterval(async () => {
      if (sending || !pointer.current || !clientId.current) {
        return;
      }
      const next = pointer.current;
      pointer.current = null;
      sending = true;
      try {
        await api(`${basePath}/pointer`, "POST", {
          id: clientId.current,
          pointer: next.pointer,
          button: next.button,
        });
      } catch {
        // The event stream handles reconnection and revoked access.
      } finally {
        sending = false;
      }
    }, 50);
    return () => {
      clearInterval(timer);
      pointer.current = null;
    };
  }, [basePath, connected, readOnly, sessionActive]);
  useEffect(() => {
    if (!id) {
      return;
    }
    api<Workspace>("/workspace")
      .then((workspace) => {
        const meta = workspace.boards.find((item) => item.id === id);
        setShared(!!meta?.shared);
        setSessionActive(!!meta?.session_active);
      })
      .catch((reason) => setError(message(reason)));
  }, [id]);
  const onChange: ExcalidrawProps["onChange"] = (elements, appState, files) => {
    if (readOnly || applying.current || appState.isLoading) {
      return;
    }
    // Keep tombstones to prevent stale participants from reviving deletions.
    const liveElements = elements;
    const usedFiles = Object.fromEntries(
      liveElements.flatMap((element) =>
        element.type === "image" && element.fileId && files[element.fileId]
          ? [[element.fileId, files[element.fileId]]]
          : [],
      ),
    );
    queue.set({
      elements: liveElements.map((element) =>
        element.type === "image" && element.fileId && files[element.fileId]
          ? { ...element, status: "saved" }
          : element,
      ),
      appState: clearAppStateForDatabase(appState),
      files: { ...editorAPI.current?.getFiles(), ...usedFiles },
    });
  };
  const publish = async (mode: "share" | "session") => {
    setShareBusy(true);
    try {
      await queue.flush();
      const result = await api<{ url: string }>(
        `/boards/${id}/${mode}`,
        "POST",
      );
      if (mode === "share") {
        setShareUrl(result.url);
        setShared(true);
      } else {
        setSessionUrl(result.url);
        setSessionActive(true);
      }
    } catch (reason) {
      setError(message(reason));
    } finally {
      setShareBusy(false);
    }
  };
  const revoke = async (mode: "share" | "session") => {
    setShareBusy(true);
    try {
      await api(`/boards/${id}/${mode}`, "DELETE");
      if (mode === "share") {
        setShared(false);
        setShareUrl("");
      } else {
        setSessionActive(false);
        setSessionUrl("");
      }
    } catch (reason) {
      setError(message(reason));
    } finally {
      setShareBusy(false);
    }
  };
  if (!available) {
    return (
      <div className="workspace-message">
        <h1>Доступ к доске закрыт</h1>
        <p>Ссылка отключена либо сервер временно недоступен.</p>
      </div>
    );
  }
  return (
    <div className="workspace-editor">
      <header className="workspace-toolbar">
        {id && (
          <a
            href="/"
            onClick={async (event) => {
              event.preventDefault();
              try {
                await queue.flush();
                ownerDocument.defaultView!.location.assign("/");
              } catch (reason) {
                setError(message(reason));
              }
            }}
          >
            ← Проекты
          </a>
        )}
        <strong>{board.name}</strong>
        <>
          {readOnly ? (
            <>
              <span>Только просмотр</span>
              <a
                href={`/api/public/${publicToken}/export`}
                download={`${board.name}.excalidraw`}
              >
                Скачать .excalidraw
              </a>
              <a
                href={`https://excalidraw.com/#url=${encodeURIComponent(
                  `${
                    ownerDocument.defaultView!.location.origin
                  }/api/public/${publicToken}/export`,
                )}`}
                target="_blank"
                rel="noreferrer"
              >
                Открыть в excalidraw.com
              </a>
            </>
          ) : (
            <>
              {sessionActive && (
                <span>
                  {connected
                    ? "Онлайн-сеанс · курсоры включены"
                    : "Сеанс · переподключение…"}
                </span>
              )}
              <span
                className={`workspace-save workspace-save--${status}`}
                role="status"
              >
                {
                  {
                    saved: "Сохранено на сервере",
                    saving: "Сохранение…",
                    pending: "Есть изменения",
                    error: "Не сохранено",
                  }[status]
                }
              </span>
              <button
                onClick={() =>
                  queue
                    .flush()
                    .catch((reason: unknown) => setError(message(reason)))
                }
              >
                Сохранить
              </button>
              {id && (
                <button disabled={shareBusy} onClick={() => publish("session")}>
                  {sessionActive ? "Новая ссылка сеанса" : "Создать сеанс"}
                </button>
              )}
              {id && sessionActive && (
                <button disabled={shareBusy} onClick={() => revoke("session")}>
                  Завершить сеанс
                </button>
              )}
              {id && (
                <button disabled={shareBusy} onClick={() => publish("share")}>
                  {shared ? "Новая ссылка просмотра" : "Поделиться доской"}
                </button>
              )}
              {id && shared && (
                <button disabled={shareBusy} onClick={() => revoke("share")}>
                  Закрыть просмотр
                </button>
              )}
            </>
          )}
        </>
      </header>
      {error && (
        <div className="workspace-error" role="alert">
          {error}
          {status === "error" &&
            " Изменения остаются в открытой вкладке. Сохраните копию через меню редактора → Экспорт."}
        </div>
      )}
      {shareUrl && (
        <div className="workspace-share">
          <label>
            Ссылка только для просмотра{" "}
            <input
              aria-label="Ссылка только для просмотра"
              readOnly
              value={shareUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <small>
            Получатель может просматривать доску, скачать копию или открыть её в
            excalidraw.com. Редактирование оригинала недоступно.
          </small>
        </div>
      )}
      {sessionUrl && (
        <div className="workspace-share">
          <label>
            Ссылка на онлайн-сеанс{" "}
            <input
              aria-label="Ссылка на онлайн-сеанс"
              readOnly
              value={sessionUrl}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <small>
            Участники могут рисовать вместе и видеть курсоры друг друга. Новая
            ссылка завершает предыдущий сеанс. Правки сохраняются на доске.
          </small>
        </div>
      )}
      <main className="workspace-canvas">
        <Excalidraw
          ownerDocument={ownerDocument}
          onExcalidrawAPI={(editor) => {
            editorAPI.current = editor;
          }}
          initialData={{ ...board.scene, scrollToContent: true }}
          onChange={onChange}
          viewModeEnabled={readOnly}
          isCollaborating={sessionActive && !readOnly}
          onPointerUpdate={
            sessionActive && !readOnly
              ? (payload) => {
                  pointer.current = payload;
                }
              : undefined
          }
          langCode="ru-RU"
          name={board.name}
        >
          <MainMenu>
            {id && <MainMenu.DefaultItems.LoadScene />}
            <MainMenu.DefaultItems.Export />
            <MainMenu.DefaultItems.SaveAsImage />
            <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
            {id && <MainMenu.DefaultItems.ClearCanvas />}
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
      </main>
    </div>
  );
}

function Dashboard({
  user,
  ownerDocument,
}: {
  user: User;
  ownerDocument: Document;
}) {
  const [workspace, setWorkspace] = useState<Workspace>({
    projects: [],
    folders: [],
    boards: [],
  });
  const [projectId, setProjectId] = useState("");
  const [folderId, setFolderId] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const refresh = async () => {
    const next = await api<Workspace>("/workspace");
    setWorkspace(next);
    setLoaded(true);
    setProjectId((current) =>
      next.projects.some((project) => project.id === current)
        ? current
        : next.projects[0]?.id || "",
    );
    setFolderId((current) =>
      next.folders.some((folder) => folder.id === current) ? current : "",
    );
  };
  useEffect(() => {
    refresh().catch((reason) => setError(message(reason)));
  }, []);
  const openAction = (next: Action) => {
    setAction(next);
    setName(next.item?.name || "");
    setError("");
  };
  const project = workspace.projects.find((item) => item.id === projectId);
  const folders = workspace.folders.filter(
    (item) => item.project_id === projectId,
  );
  const boards = workspace.boards.filter(
    (item) =>
      item.project_id === projectId &&
      (folderId ? item.folder_id === folderId : true),
  );
  const actions = (kind: Action["kind"], item: Project) => (
    <div className="workspace-item-actions">
      <button
        aria-label={`Переименовать ${item.name}`}
        onClick={() => openAction({ kind, item })}
      >
        Переименовать
      </button>
      <button
        aria-label={`Удалить ${item.name}`}
        onClick={() => openAction({ kind, item, remove: true })}
      >
        Удалить
      </button>
    </div>
  );
  const kindName = { projects: "проект", folders: "папку", boards: "доску" };
  return (
    <div className="workspace-dashboard">
      <aside className="workspace-sidebar">
        <div className="workspace-brand">
          Мои доски<span>EXCALIDRAW</span>
        </div>
        <div className="workspace-section-title">
          <h2>Проекты</h2>
          <button onClick={() => openAction({ kind: "projects" })}>
            + Проект
          </button>
        </div>
        <nav aria-label="Проекты">
          {workspace.projects.map((item) => (
            <div
              className={`workspace-project ${
                item.id === projectId ? "is-selected" : ""
              }`}
              key={item.id}
            >
              <button
                className="workspace-project-name"
                onClick={() => {
                  setProjectId(item.id);
                  setFolderId("");
                }}
              >
                {item.name}
              </button>
              {item.id === projectId && actions("projects", item)}
            </div>
          ))}
        </nav>
        <div className="workspace-account">
          <span>{user.name}</span>
          <button
            onClick={async () => {
              try {
                await api("/logout", "POST");
                ownerDocument.defaultView!.location.reload();
              } catch (reason) {
                setError(message(reason));
              }
            }}
          >
            Выйти
          </button>
        </div>
      </aside>
      <main className="workspace-content">
        <header className="workspace-content-heading">
          <div>
            <p className="workspace-eyebrow">Личное пространство</p>
            <h1>{project?.name || "Ваши проекты"}</h1>
            <p>Все доски закрыты, пока вы не откроете доступ по ссылке.</p>
          </div>
          {project && (
            <div className="workspace-buttons">
              <button onClick={() => openAction({ kind: "folders" })}>
                + Папка
              </button>
              <button
                className="workspace-primary"
                onClick={() => openAction({ kind: "boards" })}
              >
                + Доска
              </button>
            </div>
          )}
        </header>
        {error && (
          <div className="workspace-error" role="alert">
            {error}
          </div>
        )}
        {project && (
          <div className="workspace-folders">
            <button
              className={!folderId ? "is-selected" : ""}
              onClick={() => setFolderId("")}
            >
              Все доски
            </button>
            {folders.map((folder: Folder) => (
              <div
                key={folder.id}
                className={folderId === folder.id ? "is-selected" : ""}
              >
                <button onClick={() => setFolderId(folder.id)}>
                  📁 {folder.name}
                </button>
                {folderId === folder.id && actions("folders", folder)}
              </div>
            ))}
          </div>
        )}
        <div className="workspace-grid">
          {boards.map((board: Board) => (
            <article className="workspace-board" key={board.id}>
              <a className="workspace-board-link" href={`/b/${board.id}`}>
                <div className="workspace-board-preview">↗</div>
                <h2>{board.name}</h2>
              </a>
              <p>
                {board.shared ? "Доступ по ссылке" : "Закрытая доска"}
                {board.folder_id
                  ? ` · ${
                      folders.find((folder) => folder.id === board.folder_id)
                        ?.name || ""
                    }`
                  : ""}
              </p>
              <small>
                Изменена: {new Date(board.updated_at).toLocaleString("ru-RU")}
              </small>
              {actions("boards", board)}
            </article>
          ))}
        </div>
        {loaded && !boards.length && (
          <div className="workspace-empty">
            <h2>{project ? "Здесь пока нет досок" : "Начните с проекта"}</h2>
            <p>
              {project
                ? "Создайте доску в проекте или выбранной папке."
                : "Объединяйте доски по темам, храните их в папках и делитесь ссылками."}
            </p>
            <button
              className="workspace-primary"
              onClick={() =>
                openAction({ kind: project ? "boards" : "projects" })
              }
            >
              {project ? "Создать доску" : "Создать проект"}
            </button>
          </div>
        )}
      </main>
      {action && (
        <div className="workspace-modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-dialog-title"
            className="workspace-modal"
          >
            <h2 id="workspace-dialog-title">
              {action.remove
                ? "Удалить"
                : action.item
                ? "Переименовать"
                : "Создать"}{" "}
              {kindName[action.kind]}
            </h2>
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  const result = await api<{ id: string }>(
                    `/${action.kind}${action.item ? `/${action.item.id}` : ""}`,
                    action.remove ? "DELETE" : action.item ? "PATCH" : "POST",
                    action.remove
                      ? undefined
                      : {
                          name,
                          project_id: projectId,
                          folder_id: folderId || null,
                        },
                  );
                  if (!action.item && action.kind === "boards") {
                    ownerDocument.defaultView!.location.assign(
                      `/b/${result.id}`,
                    );
                    return;
                  }
                  if (!action.item && action.kind === "projects") {
                    setProjectId(result.id);
                    setFolderId("");
                  }
                  await refresh();
                  setAction(null);
                } catch (reason) {
                  setError(message(reason));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {action.remove ? (
                <p>
                  «{action.item?.name}» будет удалено без возможности
                  восстановления.
                  {action.kind !== "boards" &&
                    " Все вложенные доски также будут удалены."}
                </p>
              ) : (
                <label>
                  Название
                  <input
                    autoFocus
                    required
                    maxLength={160}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}
              {error && (
                <p className="workspace-error" role="alert">
                  {error}
                </p>
              )}
              <div className="workspace-buttons">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setAction(null)}
                >
                  Отмена
                </button>
                <button
                  className="workspace-primary"
                  disabled={busy || (!action.remove && !name.trim())}
                >
                  {busy
                    ? "Подождите…"
                    : action.remove
                    ? "Удалить"
                    : "Сохранить"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

export default function WorkspaceApp({
  ownerDocument,
}: {
  ownerDocument: Document;
}) {
  const path = ownerDocument.defaultView!.location.pathname;
  const publicToken = path.match(/^\/s\/([\w-]{43})$/)?.[1];
  const sessionToken = path.match(/^\/c\/([\w-]{43})$/)?.[1];
  const boardId = path.match(/^\/b\/([\w-]{43})$/)?.[1];
  const [user, setUser] = useState<User | null>(null);
  const [providers, setProviders] = useState({
    telegram: false,
    google: false,
  });
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (publicToken || sessionToken) {
          const next = await api<BoardData>(
            publicToken ? `/public/${publicToken}` : `/session/${sessionToken}`,
          );
          if (active) {
            setBoard(next);
          }
        } else {
          const next = await api<User>("/me");
          if (active) {
            setUser(next);
          }
          if (boardId) {
            const data = await api<BoardData>(`/boards/${boardId}`);
            if (active) {
              setBoard(data);
            }
          }
        }
      } catch (reason) {
        if (reason instanceof ApiError && reason.status === 401) {
          try {
            const available = await api<typeof providers>("/auth/providers");
            if (active) {
              setProviders(available);
            }
          } catch (error) {
            if (active) {
              setError(message(error));
            }
          }
        }
        if (active && !(reason instanceof ApiError && reason.status === 401)) {
          setError(message(reason));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [publicToken, sessionToken, boardId]);
  if (loading) {
    return (
      <div className="workspace-message" role="status">
        Загрузка…
      </div>
    );
  }
  if (error) {
    return (
      <div className="workspace-message">
        <h1>Не удалось открыть доску</h1>
        <p role="alert">{error}</p>
        <a href="/">На главную</a>
      </div>
    );
  }
  if (board) {
    return (
      <BoardEditor
        key={boardId || publicToken || sessionToken}
        board={board}
        id={boardId}
        publicToken={publicToken}
        sessionToken={sessionToken}
        ownerDocument={ownerDocument}
      />
    );
  }
  if (user) {
    return <Dashboard user={user} ownerDocument={ownerDocument} />;
  }
  const loginError = new URLSearchParams(
    ownerDocument.defaultView!.location.search,
  ).get("login");
  return (
    <div className="workspace-login">
      <div className="workspace-login-card">
        <p className="workspace-eyebrow">EXCALIDRAW · Личное пространство</p>
        <h1>Место для ваших идей</h1>
        <p>Проекты, папки и доски на вашем сервере.</p>
        <div className="workspace-login-actions">
          {providers.google && (
            <a className="workspace-primary" href="/api/auth/google">
              Войти через Google
            </a>
          )}
          {providers.telegram && (
            <a className="workspace-primary" href="/api/auth/telegram">
              Войти через Telegram
            </a>
          )}
        </div>
        <small>Вход доступен только владельцу из списка разрешённых.</small>
        {loginError && (
          <p role="alert" className="workspace-error">
            {loginError === "denied"
              ? "Ваш аккаунт отсутствует в списке разрешённых."
              : "Вход не завершён. Попробуйте ещё раз."}
          </p>
        )}
      </div>
    </div>
  );
}
