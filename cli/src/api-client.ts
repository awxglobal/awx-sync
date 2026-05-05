export interface ApiClientOptions {
  apiUrl: string;
  apiKey: string;
}

export interface FileEventPayload {
  file_path: string;
  event_type: 'created' | 'modified' | 'deleted' | 'read';
  diff?: string;
  file_size?: number;
  timestamp?: string;
}

export interface MemoryPayload {
  project_id: string;
  session_id?: string;
  category: 'bug_fix' | 'schema_change' | 'project_rule' | 'decision' | 'constraint' | 'note';
  title: string;
  body: string;
  related_files?: string[];
  supersedes?: string;
}

export class ApiClient {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor({ apiUrl, apiKey }: ApiClientOptions) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  async createProject(name: string, rootPath: string) {
    return this.request<{ id: string; name: string }>('POST', '/sync/projects', {
      name,
      root_path: rootPath,
    });
  }

  async listProjects() {
    return this.request<{ projects: Array<{ id: string; name: string }> }>(
      'GET',
      '/sync/projects',
    );
  }

  async startSession(projectId: string, tool: string) {
    return this.request<{ session: { id: string }; context_block: string | null }>(
      'POST',
      '/sync/sessions/start',
      { project_id: projectId, tool },
    );
  }

  async endSession(sessionId: string) {
    return this.request('POST', `/sync/sessions/${sessionId}/end`, {});
  }

  async ingestFileEvents(
    projectId: string,
    events: FileEventPayload[],
    sessionId?: string,
  ) {
    return this.request<{ ingested: number }>('POST', '/sync/events/files', {
      project_id: projectId,
      session_id: sessionId,
      events,
    });
  }

  async createMemory(payload: MemoryPayload) {
    return this.request('POST', '/sync/memory', payload);
  }

  async getContext(projectId: string, maxTokens = 2000): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/sync/context/${projectId}/raw?max_tokens=${maxTokens}`,
      { headers: this.headers },
    );
    if (!res.ok) throw new Error(`Failed to fetch context: ${res.status}`);
    return res.text();
  }
}
