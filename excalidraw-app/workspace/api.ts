import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

export type Project = { id: string; name: string };
export type Folder = Project & { project_id: string };
export type Board = Folder & {
  folder_id: string | null;
  revision: number;
  updated_at: number;
  shared: number;
  session_active: number;
};
export type Workspace = {
  projects: Project[];
  folders: Folder[];
  boards: Board[];
};
export type BoardData = {
  name: string;
  revision: number;
  scene: ExcalidrawInitialDataState;
};
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers:
      data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) {
    throw new ApiError(response.status, result.error || "Ошибка запроса");
  }
  return result;
}
