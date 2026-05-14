import { mockCockpitHealth, type CockpitHealth } from "@/lib/health-types";
import { readConfig, resolveProjectId } from "@/lib/config";

export async function getCockpitHealth(): Promise<CockpitHealth> {
  const config = readConfig();
  if (!config) {
    return {
      ...mockCockpitHealth,
      source: "fallback",
      message: "No config found, so the cockpit is showing a realistic amber mock state."
    };
  }

  const projectId = await resolveProjectId(config);
  if (!projectId) {
    return {
      ...mockCockpitHealth,
      source: "fallback",
      message: "No project found. Install the GitHub App first."
    };
  }

  try {
    const res = await fetch(`${config.apiUrl}/sync/health/${projectId}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store"
    });

    if (!res.ok) {
      return {
        ...mockCockpitHealth,
        source: "fallback",
        message: `Health endpoint unavailable (${res.status}). Showing amber cockpit fallback.`
      };
    }

    const health = (await res.json()) as CockpitHealth;
    return { ...health, source: "api" };
  } catch (error) {
    return {
      ...mockCockpitHealth,
      source: "fallback",
      message: `Health endpoint not reachable. Showing amber cockpit fallback. ${(error as Error).message}`
    };
  }
}
