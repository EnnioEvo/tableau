import { supabase } from "./supabase.js";

export const WORKSPACE_ROW_ID = "main";
export const WORKSPACE_TABLE = "wedding_workspaces";

export async function loadRemoteWorkspace() {
  if (!supabase) return { workspace: null, error: null };

  const { data, error } = await supabase
    .from(WORKSPACE_TABLE)
    .select("workspace")
    .eq("id", WORKSPACE_ROW_ID)
    .maybeSingle();

  return { workspace: data?.workspace ?? null, error };
}

export async function saveRemoteWorkspace(workspace) {
  if (!supabase) return;

  const { error } = await supabase.from(WORKSPACE_TABLE).upsert(
    {
      id: WORKSPACE_ROW_ID,
      workspace,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );

  if (error) throw error;
}
