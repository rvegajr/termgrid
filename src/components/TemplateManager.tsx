import { createSignal, For, Show, onMount } from "solid-js";
import * as sessionTemplates from "../services/session-templates";

interface Props {
  onClose: () => void;
  onLoadTemplate: (template: sessionTemplates.SessionTemplate) => void;
  onSaveTemplate: (name: string, description: string) => void;
  currentSession: {
    tabCount: number;
    paneCount: number;
  };
}

export function TemplateManager(props: Props) {
  const [templates, setTemplates] = createSignal<sessionTemplates.SessionTemplate[]>([]);
  const [showSaveForm, setShowSaveForm] = createSignal(false);
  const [saveName, setSaveName] = createSignal("");
  const [saveDescription, setSaveDescription] = createSignal("");

  onMount(async () => {
    const loaded = await sessionTemplates.getTemplates();
    setTemplates(loaded);
  });

  const handleSave = () => {
    if (!saveName().trim()) return;
    props.onSaveTemplate(saveName(), saveDescription());
    setSaveName("");
    setSaveDescription("");
    setShowSaveForm(false);
    
    // Reload templates
    sessionTemplates.getTemplates().then(setTemplates);
  };

  const handleDelete = async (id: string) => {
    await sessionTemplates.deleteTemplate(id);
    const updated = await sessionTemplates.getTemplates();
    setTemplates(updated);
  };

  return (
    <div
      class="template-manager-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="template-manager">
        <div class="tm-header">
          <h2>Session Templates</h2>
          <button class="tm-close" onClick={props.onClose}>✕</button>
        </div>

        <div class="tm-content">
          {/* Save Current Session */}
          <div class="tm-section">
            <h3>Current Session</h3>
            <div class="tm-current">
              <div class="tm-current-info">
                <div>{props.currentSession.tabCount} tabs</div>
                <div>{props.currentSession.paneCount} panes</div>
              </div>
              <Show
                when={!showSaveForm()}
                fallback={
                  <div class="tm-save-form">
                    <input
                      type="text"
                      placeholder="Template name..."
                      value={saveName()}
                      onInput={(e) => setSaveName(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSave();
                        if (e.key === "Escape") setShowSaveForm(false);
                      }}
                    />
                    <input
                      type="text"
                      placeholder="Description (optional)..."
                      value={saveDescription()}
                      onInput={(e) => setSaveDescription(e.currentTarget.value)}
                    />
                    <div class="tm-save-actions">
                      <button onClick={handleSave}>Save</button>
                      <button onClick={() => setShowSaveForm(false)}>Cancel</button>
                    </div>
                  </div>
                }
              >
                <button class="tm-save-btn" onClick={() => setShowSaveForm(true)}>
                  Save as Template
                </button>
              </Show>
            </div>
          </div>

          {/* Saved Templates */}
          <div class="tm-section">
            <h3>Saved Templates ({templates().length})</h3>
            <div class="tm-templates">
              <For each={templates()}>
                {(template) => (
                  <div class="tm-template-item">
                    <div class="tm-template-info">
                      <div class="tm-template-name">{template.name}</div>
                      {template.description && (
                        <div class="tm-template-desc">{template.description}</div>
                      )}
                      <div class="tm-template-meta">
                        {template.tabCount} tabs · {template.paneCount} panes
                      </div>
                    </div>
                    <div class="tm-template-actions">
                      <button
                        onClick={() => {
                          props.onLoadTemplate(template);
                          props.onClose();
                        }}
                      >
                        Load
                      </button>
                      <button
                        class="danger"
                        onClick={() => handleDelete(template.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </For>
              {templates().length === 0 && (
                <div class="tm-empty">
                  No templates saved yet. Save your current session to create one.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
