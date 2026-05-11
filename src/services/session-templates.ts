/**
 * Service for managing session templates.
 * Templates store tab/pane layouts for quick restoration.
 */

import * as machineCache from "./machine-cache";

export interface SessionTemplate {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  tabCount: number;
  paneCount: number;
  layout: {
    tabs: Array<{
      name: string;
      paneCount: number;
      layoutPreset: string;
    }>;
  };
}

const CACHE_KEY = "sessionTemplates";
const MAX_TEMPLATES = 20;

/**
 * Get all saved session templates.
 */
export async function getTemplates(): Promise<SessionTemplate[]> {
  const templates = await machineCache.get<SessionTemplate[]>(CACHE_KEY);
  return templates ?? [];
}

/**
 * Save a new template.
 */
export async function saveTemplate(template: Omit<SessionTemplate, "id" | "createdAt">): Promise<void> {
  const templates = await getTemplates();
  
  const newTemplate: SessionTemplate = {
    ...template,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  
  templates.unshift(newTemplate);
  const trimmed = templates.slice(0, MAX_TEMPLATES);
  
  await machineCache.set(CACHE_KEY, trimmed);
}

/**
 * Delete a template by ID.
 */
export async function deleteTemplate(id: string): Promise<void> {
  const templates = await getTemplates();
  const filtered = templates.filter(t => t.id !== id);
  await machineCache.set(CACHE_KEY, filtered);
}

/**
 * Get a template by ID.
 */
export async function getTemplate(id: string): Promise<SessionTemplate | null> {
  const templates = await getTemplates();
  return templates.find(t => t.id === id) ?? null;
}
