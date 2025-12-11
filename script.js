// --- 1. Utilities ---
const $ = (s, parent = document) => parent.querySelector(s);
const $$ = (s, parent = document) => Array.from(parent.querySelectorAll(s));

// Robust JSON parser
function parseRelaxedJSON(str) {
  let s = str.trim();
  
  // Remove markdown code blocks
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
  const codeBlockMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) s = codeBlockMatch[1].trim();
  
  // Clean up potential "stuttering" (duplicate lines) logic
  // This happens if the stream yields full snapshots instead of deltas
  const lines = s.split('\n');
  if (lines.length > 5) { // Only check if enough lines
    const cleanedLines = [];
    const seen = new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      // Heuristic: if we see the exact same line content again, it's likely a stutter artifact
      // BUT we must allow specific JSON structural lines like "}," or "]"
      if (trimmed === '{' || trimmed === '}' || trimmed === '},' || trimmed === ']' || trimmed.length < 3) {
        cleanedLines.push(line);
      } else if (!seen.has(trimmed)) {
        seen.add(trimmed);
        cleanedLines.push(line);
      }
    }
    // Only use cleaned version if it's significantly shorter (indicating massive duplication)
    if (cleanedLines.length < lines.length * 0.8) {
      s = cleanedLines.join('\n');
    }
  }

  // Find the OUTERMOST JSON object
  const firstOpenBrace = s.indexOf('{');
  const lastCloseBrace = s.lastIndexOf('}');
  
  if (firstOpenBrace !== -1 && lastCloseBrace !== -1 && lastCloseBrace > firstOpenBrace) {
    s = s.substring(firstOpenBrace, lastCloseBrace + 1);
  }
  
  // Remove trailing commas
  s = s.replace(/,(\s*[}\]])/g, '$1');
  
  // Fix unquoted keys
  s = s.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  
  // Remove any control characters
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  
  try {
    return JSON.parse(s);
  } catch (e) {
    console.warn("Primary parse failed, trying relaxed approach:", e);
    // Fallback: try to just parse what we have, maybe it's valid now
     try {
       // Only one more attempt with aggressive cleaning
       return JSON.parse(s.replace(/[\r\n\t]/g, ' '));
     } catch (finalError) {
       console.error("JSON Parse Failed Details:", finalError, "\nInput (truncated):", s.substring(0, 200));
       throw new Error(`JSON parsing failed: ${finalError.message}`);
     }
  }
}

function showAlert(type, message) {
  const toast = document.createElement('div');
  toast.className = `alert alert-${type} position-fixed top-0 start-50 translate-middle-x mt-3 shadow-lg`;
  toast.style.zIndex = '9999';
  toast.innerHTML = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// Dynamic Import Loader
async function load(lib) {
  const map = {
    llm: async () => ({ asyncLLM: (await import('asyncllm')).asyncLLM }),
    ui: async () => import('bootstrap-llm-provider'),
    auth: async () => import('https://cdn.jsdelivr.net/npm/@gramex/ui@0.3/dist/auth-popup.js'),
    md: async () => import('marked'),
    sb: async () => import('@supabase/supabase-js')
  };
  return await map[lib]();
}

// --- 2. State & Constants ---
const CFG_KEY = "bootstrapLLMProvider_openaiConfig";
const SB_CONFIG = {
  url: "https://nnqutlsuisayoqvfyefh.supabase.co",
  key: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5ucXV0bHN1aXNheW9xdmZ5ZWZoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzM3MzA0MzEsImV4cCI6MjA0OTMwNjQzMX0.wXqnPxJEy6Yx_LQJLdCXQqJTdCKPqVGBBqtLZvIaXdg"
};

const state = {
  user: null,
  session: null,
  signedInToastShown: false
};

let sbClient;
let gameConfig = null;
let gameInstance = null;

// --- 3. Core Initialization ---
async function init() {
  // A. Initialize Supabase
  try {
    const { createClient } = await load('sb');
    sbClient = createClient(SB_CONFIG.url, SB_CONFIG.key);
    const { data } = await sbClient.auth.getSession();
    updateAuth(data?.session);
    sbClient.auth.onAuthStateChange((evt, s) => {
      const hadUser = !!state.user;
      updateAuth(s);
      if (evt === 'SIGNED_IN' && !hadUser && !state.signedInToastShown) {
        state.signedInToastShown = true;
        showAlert('success', 'Signed in successfully<br><small>'+(s?.user?.email||'')+'</small>');
      }
      if (evt === 'SIGNED_OUT') { 
        state.signedInToastShown = false; 
        showAlert('danger', 'Signed out successfully.'); 
      }
    });
  } catch (err) {
    console.warn("Supabase initialization failed (offline or config error). Auth disabled.", err);
  }

  // B. Restore UI State (LLM Config)
  const savedLLM = getLLMConfig();
  if (savedLLM.baseUrl) checkGate();

  // C. Load game configuration
  try {
    const response = await fetch('game-config.json');
    gameConfig = await response.json();
  } catch (err) {
    console.error("Failed to load game config:", err);
    showAlert('danger', 'Failed to load game configuration');
    return;
  }

  // D. Start Game
  const gameView = $('#game-container');
  if (gameView && gameConfig) {
    gameInstance = new ManagementGame('#game-container', askLLM, gameConfig);
    await gameInstance.init();
  }
}

// --- 4. Authentication Logic ---
function updateAuth(session) {
  state.user = session?.user || null;
  const isAuth = !!state.user;
  
  $('#auth-btn').classList.toggle('d-none', isAuth);
  $('#profile-btn').classList.toggle('d-none', !isAuth);
  $('#signout-btn').classList.toggle('d-none', !isAuth);
  
  checkGate();
}

// --- 5. LLM Integration ---
function getLLMConfig() {
  try {
    return JSON.parse(localStorage.getItem(CFG_KEY)) || {};
  } catch {
    return {};
  }
}

async function* askLLM(history) {
  const { asyncLLM } = await load('llm');
  const cfg = getLLMConfig();
  
  if (!cfg.baseUrl) throw new Error("Please configure LLM settings first.");

  const model = cfg.models?.[0] || 'gpt-4o-mini';
  const systemPrompt = "You are an expert business management trainer and scenario designer. Create realistic, engaging scenarios that teach practical management skills.";
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${cfg.apiKey}`
  };
  
  const body = {
    model,
    stream: true,
    messages: [{ role: 'system', content: systemPrompt }, ...history]
  };

  try {
    for await (const chunk of asyncLLM(url, { method: 'POST', headers, body: JSON.stringify(body) })) {
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.content) yield chunk.content;
    }
  } catch (e) {
    console.warn("Stream failed, falling back to fetch", e);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...body, stream: false })
    });
    const data = await res.json();
    yield data.choices?.[0]?.message?.content || "";
  }
}

const checkGate = () => {
  const hasConfig = !!getLLMConfig().baseUrl;
};

// Global Event Listener (Delegation)
document.addEventListener('click', async (e) => {
  const target = e.target;

  // Configure LLM Button
  if (target.closest('#configure-llm')) {
    try {
      const { openaiConfig } = await load('ui');
      const prev = getLLMConfig().baseUrl;
      const prevK = getLLMConfig().apiKey;
      await openaiConfig({ show: true });
      checkGate();
      const next = getLLMConfig().baseUrl;
      const nextK = getLLMConfig().apiKey;
      if (next && (next !== prev || nextK !== prevK)) {
        showAlert('success', 'LLM configured');
        // Restart game if already started
        if (gameInstance && gameInstance.gameStarted) {
          showAlert('info', 'Please restart the game to apply new settings');
        }
      }
    } catch {}
  }

  // Auth: Sign In
  if (target.closest('#auth-btn')) {
    if (!sbClient) {
      showAlert('danger', '<b>Authentication Unavailable</b><br>Could not connect to the database.');
      return;
    }
    try {
      const popup = await load('auth');
      await popup.default(sbClient, { provider: 'google' });
    } catch (e) {
      console.warn("Auth popup failed", e);
      if (sbClient && sbClient.auth) {
        sbClient.auth.signInWithOAuth({ 
          provider: 'google', 
          options: { redirectTo: location.href } 
        }).catch(() => showAlert('danger', 'Sign in failed.'));
      }
    }
  }

  // Auth: Sign Out
  if (target.closest('#signout-btn')) {
    if (sbClient && sbClient.auth) await sbClient.auth.signOut();
  }
});

// Start
window.addEventListener('load', init);

// --- 6. Sound Effects ---
class SoundEffects {
  constructor() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.enabled = true;
  }
  
  playTone(freq, duration, type = 'sine') {
    if (!this.enabled) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.frequency.value = freq;
    osc.type = type;
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.00001, this.ctx.currentTime + duration);
    osc.stop(this.ctx.currentTime + duration);
  }
  
  playClick() { this.playTone(800, 0.05, 'square'); }
  playSuccess() { 
    this.playTone(600, 0.1, 'sine'); 
    setTimeout(() => this.playTone(900, 0.2, 'sine'), 100); 
  }
  playError() { this.playTone(200, 0.3, 'sawtooth'); }
  playNotification() { this.playTone(1000, 0.1, 'sine'); }
}

// --- 7. Main Game Class ---
class ManagementGame {
  constructor(containerId, askLLMFn, config) {
    this.container = document.querySelector(containerId);
    this.askLLM = askLLMFn;
    this.config = config;
    this.sounds = new SoundEffects();
    
    // Game state
    this.gameStarted = false;
    this.questionsAnswered = 0; // New: Track questions for NPC intrusion
    this.selectedIndustry = null;
    this.selectedRole = null;
    this.selectedDifficulty = null;
    this.currentDay = 1;
    this.kpis = {};
    this.npcs = [];
    this.gameLog = [];
    this.scenarioHistory = [];
    
    // Custom industry support
    this.isCustomIndustry = false;
    this.customKPIs = null;
    this.kpiDefinitions = null;
  }

  async init() {
    this.renderWelcomeScreen();
  }

  renderWelcomeScreen() {
    this.container.innerHTML = `
      <div class="min-vh-100 d-flex flex-column justify-content-center align-items-center text-white p-4" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="text-center mb-5">
          <h1 class="display-3 mb-3 fw-bold" style="text-shadow: 0 0 20px rgba(13,110,253,0.5);">
            <i class="bi bi-briefcase-fill me-3"></i>
            Strategy Game Simulator
          </h1>
          <p class="lead text-white-50 mb-4">
            Learn real-world management skills through interactive scenarios
          </p>
        </div>

        <div class="card bg-dark border-light shadow-lg" style="max-width: 600px; width: 100%;">
          <div class="card-body p-5">
            <h4 class="card-title text-center mb-4 text-primary">
              <i class="bi bi-play-circle-fill me-2"></i>
              Ready to Begin?
            </h4>
            <p class="text-white-50 text-center mb-4">
              You'll be placed in realistic management scenarios where your decisions matter. 
              Work with your team, manage resources, and handle unexpected challenges.
            </p>
            
            <div class="alert alert-info mb-4">
              <i class="bi bi-info-circle-fill me-2"></i>
              <strong>What to expect:</strong>
              <ul class="mb-0 mt-2 small">
                <li>Choose your industry and role</li>
                <li>Interact with AI-powered team members</li>
                <li>Make decisions that affect multiple KPIs</li>
                <li>Learn from consequences in a safe environment</li>
              </ul>
            </div>

            <div class="d-grid gap-2">
              <button id="start-setup-btn" class="btn btn-primary btn-lg">
                <i class="bi bi-arrow-right-circle-fill me-2"></i>
                Start Setup
              </button>
            </div>
          </div>
        </div>

        <div class="mt-4 text-white-50 small text-center">
          <i class="bi bi-cpu me-1"></i>
          Powered by AI | Realistic Scenarios | Safe Learning Environment
        </div>
      </div>
    `;

    $('#start-setup-btn').onclick = () => this.renderIndustrySelection();
  }

  renderIndustrySelection() {
    // Optimization: If only one industry exists, auto-select it
    if (this.config.industries.length === 1) {
      this.selectedIndustry = this.config.industries[0];
      this.isCustomIndustry = false;
      this.renderRoleSelection();
      return;
    }

    this.sounds.playClick();
    
    const industriesHTML = this.config.industries.map(industry => `
      <div class="col-md-6 mb-3">
        <div class="card bg-dark border-secondary h-100 industry-card" 
             data-industry="${industry.id}"
             style="cursor: pointer; transition: all 0.3s;">
          <div class="card-body text-center p-4">
            <i class="bi ${industry.icon} display-1 text-primary mb-3"></i>
            <h5 class="card-title text-white mb-3">${industry.name}</h5>
            <p class="card-text text-white-50 small">${industry.description}</p>
            <div class="mt-3">
              <span class="badge bg-secondary me-1">${industry.roles.length} Role${industry.roles.length > 1 ? 's' : ''}</span>
              <span class="badge bg-secondary">${industry.npcs.length} NPCs</span>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="min-vh-100 p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="container" style="max-width: 900px;">
          <div class="text-center mb-5">
            <h2 class="display-5 mb-3">
              <i class="bi bi-building me-2"></i>
              Choose Your Industry
            </h2>
            <p class="text-white-50">Select a pre-built industry or create your own</p>
          </div>

          <div class="row">
            ${industriesHTML}
            
            <!-- Custom Industry Card -->
            <div class="col-md-6 mb-3">
              <div class="card bg-dark border-warning h-100" 
                   id="custom-industry-card"
                   style="cursor: pointer; transition: all 0.3s;">
                <div class="card-body text-center p-4">
                  <i class="bi bi-stars display-1 text-warning mb-3"></i>
                  <h5 class="card-title text-warning mb-3">Create Custom Industry</h5>
                  <p class="card-text text-white-50 small">
                    Define your own industry and let AI generate KPIs, roles, and NPCs
                  </p>
                  <div class="mt-3">
                    <span class="badge bg-warning text-dark">AI-Powered</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="text-center mt-4">
            <button id="back-btn" class="btn btn-outline-light">
              <i class="bi bi-arrow-left me-2"></i>Back
            </button>
          </div>
        </div>
      </div>
    `;

    // Add hover effects for pre-built industries
    $$('.industry-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-5px)';
        card.style.borderColor = '#0d6efd';
        card.style.boxShadow = '0 5px 20px rgba(13,110,253,0.3)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.borderColor = '';
        card.style.boxShadow = '';
      });
      card.addEventListener('click', () => {
        this.sounds.playClick();
        const industryId = card.dataset.industry;
        this.selectedIndustry = this.config.industries.find(i => i.id === industryId);
        this.isCustomIndustry = false;
        this.renderRoleSelection();
      });
    });

    // Custom industry card hover and click
    const customCard = $('#custom-industry-card');
    customCard.addEventListener('mouseenter', () => {
      customCard.style.transform = 'translateY(-5px)';
      customCard.style.boxShadow = '0 5px 20px rgba(255,193,7,0.3)';
    });
    customCard.addEventListener('mouseleave', () => {
      customCard.style.transform = 'translateY(0)';
      customCard.style.boxShadow = '';
    });
    customCard.addEventListener('click', () => {
      this.sounds.playClick();
      this.renderCustomIndustryForm();
    });

    $('#back-btn').onclick = () => {
      this.sounds.playClick();
      this.renderWelcomeScreen();
    };
  }

  async renderCustomIndustryForm() {
    this.container.innerHTML = `
      <div class="min-vh-100 d-flex align-items-center justify-content-center p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="card bg-dark border-warning shadow-lg" style="max-width: 600px; width: 100%;">
          <div class="card-body p-5">
            <h3 class="card-title text-center mb-4 text-warning">
              <i class="bi bi-stars me-2"></i>
              Create Custom Industry
            </h3>

            <div class="alert alert-info mb-4">
              <small>
                <i class="bi bi-lightbulb-fill me-2"></i>
                <strong>AI will generate:</strong> Relevant KPIs, management roles, team members (NPCs), 
                and realistic scenarios for your industry.
              </small>
            </div>

            <div class="mb-4">
              <label class="form-label text-warning">Industry Name</label>
              <input type="text" id="custom-industry-name" class="form-control form-control-lg bg-dark text-white border-secondary" 
                     placeholder="e.g., E-commerce Startup, Hospital, Construction Company">
              <small class="text-white-50 mt-1 d-block">Be specific for better AI generation</small>
            </div>

            <div class="mb-4">
              <label class="form-label text-warning">Brief Description (Optional)</label>
              <textarea id="custom-industry-desc" class="form-control bg-dark text-white border-secondary" 
                        rows="3" placeholder="e.g., A fast-growing online retail platform selling electronics..."></textarea>
              <small class="text-white-50 mt-1 d-block">Helps AI understand context</small>
            </div>

            <div class="d-grid gap-2">
              <button id="generate-industry-btn" class="btn btn-warning btn-lg">
                <i class="bi bi-cpu-fill me-2"></i>
                Generate Industry with AI
              </button>
              <button id="back-to-selection-btn" class="btn btn-outline-light">
                <i class="bi bi-arrow-left me-2"></i>
                Back to Selection
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    $('#generate-industry-btn').onclick = () => this.generateCustomIndustry();
    $('#back-to-selection-btn').onclick = () => this.renderIndustrySelection();
  }

  async generateCustomIndustry() {
    const name = $('#custom-industry-name').value.trim();
    const description = $('#custom-industry-desc').value.trim();

    if (!name) {
      showAlert('warning', 'Please enter an industry name');
      return;
    }

    this.sounds.playClick();

    // Show loading screen
    this.container.innerHTML = `
      <div class="min-vh-100 d-flex align-items-center justify-content-center p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="text-center">
          <div class="spinner-border text-warning mb-4" style="width: 4rem; height: 4rem;"></div>
          <h3 class="mb-3">AI is Creating Your Industry...</h3>
          <p class="text-white-50">Generating KPIs, roles, NPCs, and scenarios for "${name}"</p>
          <div class="mt-4">
            <div class="progress" style="height: 4px; max-width: 400px; margin: 0 auto;">
              <div class="progress-bar progress-bar-striped progress-bar-animated bg-warning" style="width: 100%"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    const prompt = `You are a game designer creating a Strategy Game simulator for the industry: "${name}".
${description ? `Industry context: ${description}` : ''}

Generate a complete industry configuration with:
1. 5-7 relevant KPIs (Key Performance Indicators) specific to this industry
2. 2-3 management roles
3. 5-7 NPCs (team members, stakeholders) with personalities
4. Starting values for each KPI per role

CRITICAL RULES:
- Output ONLY valid JSON
- NO markdown, NO code blocks, NO explanations  
- Use single-line strings (no newlines in values)
- No control characters or special formatting

Format:
{
  "id": "industry-id-lowercase-hyphenated",
  "name": "${name}",
  "icon": "bi-icon-name",
  "description": "One-line description",
  "kpis": {
    "kpi1": {"name": "KPI Name", "icon": "bi-icon", "description": "What it measures", "unit": "$|%|number"},
    "kpi2": {"name": "KPI Name", "icon": "bi-icon", "description": "What it measures", "unit": "$|%|number"}
  },
  "roles": [
    {
      "id": "role-id",
      "name": "Role Name",
      "description": "What this role does",
      "startingKPIs": {"kpi1": 50000, "kpi2": 75}
    }
  ],
  "npcs": [
    {
      "id": "npc-id",
      "name": "First Name",
      "role": "Job Title",
      "personality": "Brief personality description",
      "avatar": "👤"
    }
  ]
}`;

    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let fullText = "";
      for await (const chunk of responseStream) {
        if (chunk.startsWith(fullText) && fullText.length > 0) {
          // Snapshot capability detection: buffer is being resent
          fullText = chunk; 
        } else {
          fullText += chunk;
        }
      }

      console.log("Custom Industry Generation:", fullText.substring(0, 300) + "...");
      const industryData = parseRelaxedJSON(fullText);

      // Validate structure
      if (!industryData.kpis || !industryData.roles || !industryData.npcs) {
        throw new Error("Invalid industry structure");
      }

      // Store as selected industry
      this.selectedIndustry = industryData;
      this.isCustomIndustry = true;
      this.customKPIs = industryData.kpis;

      showAlert('success', `Industry "${name}" created successfully!`);
      this.sounds.playSuccess();
      
      // Move to role selection
      setTimeout(() => this.renderRoleSelection(), 1000);

    } catch (e) {
      console.error("Custom industry generation failed:", e);
      this.container.innerHTML = `
        <div class="min-vh-100 d-flex align-items-center justify-content-center p-4 text-white" 
             style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
          <div class="card bg-dark border-danger shadow-lg" style="max-width: 600px;">
            <div class="card-body p-5 text-center">
              <i class="bi bi-exclamation-triangle-fill text-danger display-1 mb-3"></i>
              <h4 class="text-danger mb-3">Generation Failed</h4>
              <p class="text-white-50 mb-4">${e.message}</p>
              <div class="d-grid gap-2">
                <button class="btn btn-warning" onclick="location.reload()">Try Again</button>
                <button class="btn btn-outline-light" id="back-btn-error">Choose Pre-built Industry</button>
              </div>
            </div>
          </div>
        </div>
      `;
      $('#back-btn-error').onclick = () => this.renderIndustrySelection();
    }
  }

  renderRoleSelection() {
    const rolesHTML = this.selectedIndustry.roles.map(role => `
      <div class="col-md-6 mb-3">
        <div class="card bg-dark border-secondary h-100 role-card" 
             data-role="${role.id}"
             style="cursor: pointer; transition: all 0.3s;">
          <div class="card-body p-4">
            <h5 class="card-title text-primary mb-3">
              <i class="bi bi-person-badge me-2"></i>
              ${role.name}
            </h5>
            <p class="card-text text-white-50 mb-4">${role.description}</p>
            
            <div class="small">
              <div class="text-white-50 mb-2"><strong>Starting Resources:</strong></div>
              <div class="d-flex flex-wrap gap-2">
                ${Object.entries(role.startingKPIs).map(([key, value]) => {
                  const kpiDefs = this.isCustomIndustry && this.customKPIs ? this.customKPIs : this.config.kpiDescriptions;
                  const kpiInfo = kpiDefs[key];
                  return `<span class="badge bg-secondary">
                    <i class="bi ${kpiInfo.icon} me-1"></i>
                    ${kpiInfo.unit === '$' ? '$' + value.toLocaleString() : value + kpiInfo.unit}
                  </span>`;
                }).join('')}
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="min-vh-100 p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="container" style="max-width: 900px;">
          <div class="text-center mb-5">
            <h2 class="display-5 mb-3">
              <i class="bi bi-person-circle me-2"></i>
              Choose Your Role
            </h2>
            <p class="text-white-50">Industry: <strong class="text-primary">${this.selectedIndustry.name}</strong></p>
          </div>

          <div class="row">
            ${rolesHTML}
          </div>

          <div class="text-center mt-4">
            <button id="back-btn" class="btn btn-outline-light">
              <i class="bi bi-arrow-left me-2"></i>Back
            </button>
          </div>
        </div>
      </div>
    `;

    $$('.role-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-5px)';
        card.style.borderColor = '#0d6efd';
        card.style.boxShadow = '0 5px 20px rgba(13,110,253,0.3)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.borderColor = '';
        card.style.boxShadow = '';
      });
      card.addEventListener('click', () => {
        this.sounds.playClick();
        const roleId = card.dataset.role;
        this.selectedRole = this.selectedIndustry.roles.find(r => r.id === roleId);
        this.renderDifficultySelection();
      });
    });

    $('#back-btn').onclick = () => {
      this.sounds.playClick();
      this.renderIndustrySelection();
    };
  }

  renderDifficultySelection() {
    const difficultiesHTML = this.config.difficulties.map(diff => `
      <div class="col-md-6 mb-3">
        <div class="card bg-dark border-secondary h-100 difficulty-card" 
             data-difficulty="${diff.id}"
             style="cursor: pointer; transition: all 0.3s;">
          <div class="card-body p-4">
            <h5 class="card-title text-warning mb-3">
              <i class="bi bi-speedometer2 me-2"></i>
              ${diff.name}
            </h5>
            <p class="card-text text-white-50 mb-3">${diff.description}</p>
            
            <div class="small">
              <div class="d-flex justify-content-between mb-2">
                <span class="text-white-50">Duration:</span>
                <span class="text-white"><strong>${diff.daysToComplete} days</strong></span>
              </div>
              <div class="d-flex justify-content-between mb-2">
                <span class="text-white-50">Event Frequency:</span>
                <span class="text-white"><strong>${diff.eventFrequency}</strong></span>
              </div>
              <div class="d-flex justify-content-between">
                <span class="text-white-50">Challenge Level:</span>
                <span class="text-white"><strong>${'⭐'.repeat(this.config.difficulties.indexOf(diff) + 1)}</strong></span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="min-vh-100 p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="container" style="max-width: 900px;">
          <div class="text-center mb-5">
            <h2 class="display-5 mb-3">
              <i class="bi bi-sliders me-2"></i>
              Choose Difficulty
            </h2>
            <p class="text-white-50">
              Industry: <strong class="text-primary">${this.selectedIndustry.name}</strong> | 
              Role: <strong class="text-primary">${this.selectedRole.name}</strong>
            </p>
          </div>

          <div class="row">
            ${difficultiesHTML}
          </div>

          <div class="text-center mt-4">
            <button id="back-btn" class="btn btn-outline-light">
              <i class="bi bi-arrow-left me-2"></i>Back
            </button>
          </div>
        </div>
      </div>
    `;

    $$('.difficulty-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-5px)';
        card.style.borderColor = '#ffc107';
        card.style.boxShadow = '0 5px 20px rgba(255,193,7,0.3)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.borderColor = '';
        card.style.boxShadow = '';
      });
      card.addEventListener('click', () => {
        this.sounds.playClick();
        const difficultyId = card.dataset.difficulty;
        this.selectedDifficulty = this.config.difficulties.find(d => d.id === difficultyId);
        this.renderGameSummary();
      });
    });

    $('#back-btn').onclick = () => {
      this.sounds.playClick();
      this.renderRoleSelection();
    };
  }

  renderGameSummary() {
    this.container.innerHTML = `
      <div class="min-vh-100 d-flex align-items-center justify-content-center p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="card bg-dark border-light shadow-lg" style="max-width: 700px; width: 100%;">
          <div class="card-body p-5">
            <h3 class="card-title text-center mb-4 text-success">
              <i class="bi bi-check-circle-fill me-2"></i>
              Ready to Start!
            </h3>

            <div class="alert alert-dark border-secondary mb-4">
              <h5 class="text-primary mb-3">Your Training Setup:</h5>
              <div class="row g-3">
                <div class="col-6">
                  <div class="small text-white-50">Industry</div>
                  <div class="fw-bold">${this.selectedIndustry.name}</div>
                </div>
                <div class="col-6">
                  <div class="small text-white-50">Role</div>
                  <div class="fw-bold">${this.selectedRole.name}</div>
                </div>
                <div class="col-6">
                  <div class="small text-white-50">Difficulty</div>
                  <div class="fw-bold">${this.selectedDifficulty.name}</div>
                </div>
                <div class="col-6">
                  <div class="small text-white-50">Duration</div>
                  <div class="fw-bold">${this.selectedDifficulty.daysToComplete} Days</div>
                </div>
              </div>
            </div>

            <div class="alert alert-info mb-4">
              <h6 class="mb-2"><i class="bi bi-people-fill me-2"></i>Your Team:</h6>
              <div class="d-flex flex-wrap gap-2">
                ${this.selectedIndustry.npcs.map(npc => `
                  <span class="badge bg-secondary" title="${npc.personality}">
                    ${npc.avatar} ${npc.name} - ${npc.role}
                  </span>
                `).join('')}
              </div>
            </div>

            <div class="alert alert-warning mb-4">
              <h6 class="mb-2"><i class="bi bi-graph-up me-2"></i>Starting KPIs:</h6>
              <div class="row g-2 small">
                ${Object.entries(this.selectedRole.startingKPIs).map(([key, value]) => {
                  const kpiDefs = this.isCustomIndustry && this.customKPIs ? this.customKPIs : this.config.kpiDescriptions;
                  const kpiInfo = kpiDefs[key];
                  return `
                    <div class="col-6">
                      <i class="bi ${kpiInfo.icon} me-1"></i>
                      ${kpiInfo.name}: <strong>${kpiInfo.unit === '$' ? '$' + value.toLocaleString() : value + kpiInfo.unit}</strong>
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <div class="d-grid gap-2">
              <button id="start-game-btn" class="btn btn-success btn-lg">
                <i class="bi bi-play-fill me-2"></i>
                Start Training
              </button>
              <button id="back-btn" class="btn btn-outline-light">
                <i class="bi bi-arrow-left me-2"></i>
                Change Settings
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    $('#start-game-btn').onclick = () => {
      this.sounds.playSuccess();
      this.startGame();
    };

    $('#back-btn').onclick = () => {
      this.sounds.playClick();
      this.renderDifficultySelection();
    };
  }

  async startGame() {
    this.gameStarted = true;
    
    this.container.innerHTML = `
      <div class="min-vh-100 d-flex flex-column justify-content-center align-items-center text-white p-4" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="spinner-border text-primary mb-3" role="status"></div>
        <h4 class="mb-2">Initializing AI Simulation...</h4>
        <div class="text-white-50">Recruiting your team...</div>
      </div>
    `;

    this.kpis = { ...this.selectedRole.startingKPIs };
    
    if (this.isCustomIndustry && this.customKPIs) {
      this.kpiDefinitions = this.customKPIs;
      this.npcs = [...this.selectedIndustry.npcs];
    } else {
      this.kpiDefinitions = this.config.kpiDescriptions;
      try {
        this.npcs = await this.generateDynamicNPCs(this.selectedIndustry);
      } catch (e) {
        this.npcs = [...this.selectedIndustry.npcs];
      }
    }
    
    this.currentDay = 1;
    this.gameLog = [];
    this.scenarioHistory = [];
    
    // Initialize Game Systems
    this.purchasedUpgrades = [];
    this.dailyStrategy = null;

    // Initialize Daily Events list
    this.dailyEvents = [
      { name: "Quiet Monday", effect: "Normal operations", context: "It's a slow start to the week." },
      { name: "Lunch Rush", effect: "High customer volume", context: "Customers are lining up out the door!" },
      { name: "Health Inspection", effect: "Strict quality control", context: "The health inspector is in town." },
      { name: "Supply Chain Issues", effect: "Inventory shortage", context: "Delivery trucks are delayed." },
      { name: "Festival Nearby", effect: "Chaotic crowds", context: "A local music festival is drawing huge crowds." },
      { name: "Heavy Rain", effect: "Low footfall", context: "The weather is keeping customers away." },
      { name: "Viral Review", effect: "Reputation scrutiny", context: "A food critic just posted about us." }
    ];
    this.currentDailyEvent = this.dailyEvents[0];

    this.renderMorningBriefing();
  }

  renderMorningBriefing() {
    // Select Random Event for the upcoming day
    if (this.currentDay > 1) {
       this.currentDailyEvent = this.dailyEvents[Math.floor(Math.random() * this.dailyEvents.length)];
    }

    const upgradesHTML = this.config.upgrades.map(u => {
      const isOwned = this.purchasedUpgrades.includes(u.id);
      const canAfford = this.kpis.budget >= u.cost;
      return `
        <div class="col-md-6 mb-3">
          <div class="card bg-dark border-${isOwned ? 'success' : 'secondary'} h-100 upgrade-card ${isOwned ? 'opacity-75' : ''}" 
               data-id="${u.id}" 
               style="cursor: ${isOwned || !canAfford ? 'default' : 'pointer'}">
            <div class="card-body d-flex align-items-center">
              <div class="fs-1 me-3 text-${isOwned ? 'success' : 'primary'}"><i class="bi ${u.icon}"></i></div>
              <div class="flex-grow-1">
                <h6 class="mb-1">${u.name} ${isOwned ? '<i class="bi bi-check-circle-fill text-success"></i>' : ''}</h6>
                <div class="small text-white-50 mb-2">${u.description}</div>
                <div class="fw-bold text-${isOwned ? 'success' : canAfford ? 'warning' : 'danger'}">
                  ${isOwned ? 'OWNED' : '$' + u.cost.toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    const strategiesHTML = this.config.strategies.map(s => `
      <div class="col-4">
        <input type="radio" class="btn-check" name="strategy" id="strat-${s.id}" value="${s.id}" autocomplete="off" ${s.id === 'balanced' ? 'checked' : ''}>
        <label class="btn btn-outline-primary w-100 h-100 d-flex flex-column justify-content-center p-3" for="strat-${s.id}">
          <div class="fw-bold mb-1">${s.name}</div>
          <div class="small text-white-50" style="font-size: 0.75rem;">${s.description}</div>
        </label>
      </div>
    `).join('');

    this.container.innerHTML = `
      <div class="min-vh-100 p-4 text-white" style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="container" style="max-width: 900px;">
          
          <div class="text-center mb-5">
            <h2 class="display-5 text-warning mb-2"><i class="bi bi-sunrise me-2"></i>Morning Briefing</h2>
            <p class="lead text-white-50">Day ${this.currentDay}: ${this.currentDailyEvent.name}</p>
          </div>

          <!-- Daily Strategy -->
          <div class="card bg-dark border-primary mb-4">
            <div class="card-header bg-primary bg-opacity-25 border-bottom border-primary">
              <h5 class="mb-0 text-white"><i class="bi bi-crosshair me-2"></i>Set Daily Strategy</h5>
            </div>
            <div class="card-body">
              <div class="row g-3">
                ${strategiesHTML}
              </div>
            </div>
          </div>

          <!-- Shop / Upgrades -->
          <div class="card bg-dark border-secondary mb-4">
            <div class="card-header bg-secondary bg-opacity-25 border-bottom border-secondary d-flex justify-content-between align-items-center">
              <h5 class="mb-0 text-white"><i class="bi bi-shop me-2"></i>Upgrade Store</h5>
              <div class="badge bg-success fs-6">Budget: $${this.kpis.budget.toLocaleString()}</div>
            </div>
            <div class="card-body">
              <div class="row" id="upgrades-list">
                ${upgradesHTML}
              </div>
            </div>
          </div>

          <div class="d-grid">
            <button id="start-day-btn" class="btn btn-success btn-lg py-3">
              <i class="bi bi-play-fill me-2"></i>Open Restaurant
            </button>
          </div>

        </div>
      </div>
    `;

    // Bind Upgrade Clicks
    $$('.upgrade-card').forEach(card => {
      card.onclick = () => {
        const id = card.dataset.id;
        const upgrade = this.config.upgrades.find(u => u.id === id);
        
        if (this.purchasedUpgrades.includes(id)) return;
        
        if (this.kpis.budget >= upgrade.cost) {
          this.sounds.playSuccess();
          this.kpis.budget -= upgrade.cost;
          this.purchasedUpgrades.push(id);
          
          // Apply immediate effects
          if (upgrade.effect) {
             Object.entries(upgrade.effect).forEach(([k, v]) => {
               if (this.kpis[k] !== undefined) {
                 this.kpis[k] = Math.min(100, this.kpis[k] + v);
               }
             });
          }
          this.renderMorningBriefing(); // Re-render to update UI
          showAlert('success', `Purchased ${upgrade.name}!`);
        } else {
          this.sounds.playError();
          showAlert('danger', 'Not enough budget!');
        }
      };
    });

    $('#start-day-btn').onclick = () => {
      this.sounds.playClick();
      const selectedStratId = $('input[name="strategy"]:checked').value;
      this.dailyStrategy = this.config.strategies.find(s => s.id === selectedStratId);
      this.startNewDay();
    };
  }

  startNewDay() {
    this.renderGameScreen();
    this.generateScenario();
  }

  renderGameScreen() {
    const kpisHTML = Object.entries(this.kpis).map(([key, value]) => {
      const kpiInfo = this.kpiDefinitions[key];
      const percentage = key !== 'budget' && key !== 'sales' ? value : null;
      const color = percentage ? (percentage >= 70 ? 'success' : percentage >= 40 ? 'warning' : 'danger') : 'primary';
      
      return `
        <div class="col-md-4 col-lg-3 mb-3">
          <div class="card bg-dark border-${color} h-100">
            <div class="card-body p-3">
              <div class="d-flex align-items-center mb-2">
                <i class="bi ${kpiInfo.icon} text-${color} me-2"></i>
                <small class="text-white-50">${kpiInfo.name}</small>
              </div>
              <div class="fs-4 fw-bold text-${color}" id="kpi-${key}">
                ${kpiInfo.unit === '$' ? '$' + Math.floor(value).toLocaleString() : Math.floor(value) + (kpiInfo.unit === 'number' ? '' : kpiInfo.unit)}
              </div>
              ${percentage !== null ? `
                <div class="progress mt-2" style="height: 4px;">
                  <div class="progress-bar bg-${color}" style="width: ${Math.min(100, Math.max(0, percentage))}%"></div>
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `;
    }).join('');

    this.container.innerHTML = `
      <div class="min-vh-100 p-3 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        
        <!-- Header -->
        <div class="container-fluid mb-3">
          <div class="row align-items-center">
            <div class="col">
              <h4 class="mb-0">
                <i class="bi bi-briefcase-fill me-2 text-primary"></i>
                ${this.selectedIndustry.name} - ${this.selectedRole.name}
              </h4>
              <small class="text-white-50">Day ${this.currentDay} of ${this.selectedDifficulty.daysToComplete}</small>
            </div>
            
            <div class="col-auto text-end">
               <div class="badge bg-warning text-dark mb-1"><i class="bi bi-calendar-event me-1"></i> ${this.currentDailyEvent.name}</div>
               <div class="small text-white-50" style="font-size: 0.75rem;">${this.currentDailyEvent.context}</div>
            </div>

            <div class="col-auto">
              <div class="progress" style="width: 200px; height: 8px;">
                <div class="progress-bar bg-success" style="width: ${(this.currentDay / this.selectedDifficulty.daysToComplete) * 100}%"></div>
              </div>
            </div>
          </div>
        </div>

        <!-- KPIs Dashboard -->
        <div class="container-fluid mb-3">
          <div class="row" id="kpis-container">
            ${kpisHTML}
          </div>
        </div>

        <!-- Main Content Area -->
        <div class="container-fluid">
          <div class="row">
            <!-- Scenario Panel -->
            <div class="col-lg-8 mb-3">
              <div class="card bg-dark border-light h-100">
                <div class="card-header bg-transparent border-bottom border-secondary">
                  <h5 class="mb-0">
                    <i class="bi bi-newspaper me-2"></i>
                    Current Situation
                  </h5>
                </div>
                <div class="card-body" id="scenario-container" style="min-height: 400px;">
                  <div class="d-flex justify-content-center align-items-center h-100">
                    <div class="spinner-border text-primary" role="status">
                      <span class="visually-hidden">Loading...</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Side Panel -->
            <div class="col-lg-4">
              <!-- NPCs -->
              <div class="card bg-dark border-light mb-3">
                <div class="card-header bg-transparent border-bottom border-secondary">
                  <h6 class="mb-0">
                    <i class="bi bi-people-fill me-2"></i>
                    Your Team
                  </h6>
                </div>
                <div class="card-body p-2">
                  ${this.npcs.map(npc => `
                    <div class="d-flex align-items-center p-2 mb-1 rounded bg-secondary bg-opacity-25 npc-item" 
                         data-npc="${npc.id}" 
                         style="cursor: pointer; transition: all 0.2s;"
                         title="${npc.personality}">
                      <div class="fs-3 me-2">${npc.avatar}</div>
                      <div class="flex-grow-1">
                        <div class="fw-bold small">${npc.name}</div>
                        <div class="text-white-50" style="font-size: 0.75rem;">${npc.role}</div>
                      </div>
                      <i class="bi bi-chat-dots text-primary"></i>
                    </div>
                  `).join('')}
                </div>
              </div>

              <!-- Activity Log -->
              <div class="card bg-dark border-light">
                <div class="card-header bg-transparent border-bottom border-secondary">
                  <h6 class="mb-0">
                    <i class="bi bi-clock-history me-2"></i>
                    Activity Log
                  </h6>
                </div>
                <div class="card-body p-2" id="activity-log" style="max-height: 300px; overflow-y: auto;">
                  <div class="small text-white-50 text-center p-3">
                    Game started. Good luck!
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Add NPC click handlers
    $$('.npc-item').forEach(item => {
      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = 'rgba(13, 110, 253, 0.2)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = '';
      });
      item.addEventListener('click', () => {
        this.sounds.playClick();
        const npcId = item.dataset.npc;
        const npc = this.npcs.find(n => n.id === npcId);
        this.talkToNPC(npc);
      });
    });
  }

  async generateScenario() {
    const scenarioContainer = $('#scenario-container');
    scenarioContainer.innerHTML = `
      <div class="d-flex flex-column justify-content-center align-items-center h-100">
        <div class="spinner-border text-primary mb-3" role="status"></div>
        <div class="text-white-50">AI is crafting a unique challenge...</div>
      </div>
    `;

    // 1. Identify Critical KPI (lowest normalized score)
    // Budget can be high, so we ignore it for "crisis" finding unless it's near 0
    // We normalize budget/sales for comparison, but simple sorting of percentage based KPIs is better
    const criticalKPIs = Object.entries(this.kpis)
      .filter(([k]) => k !== 'budget' && k !== 'sales')
      .sort(([, a], [, b]) => a - b);
    const lowestKPI = criticalKPIs[0] ? { id: criticalKPIs[0][0], value: criticalKPIs[0][1] } : null;

    // 2. Select Relevant NPC
    // Try to match NPC role to the KPI if possible, otherwise random
    let relevantNPC = this.npcs[Math.floor(Math.random() * this.npcs.length)];
    if (lowestKPI) {
       // Simple heuristic mapping for Better Context
       if (lowestKPI.id.includes('Food') || lowestKPI.id.includes('inventory')) {
          const chef = this.npcs.find(n => n.role.includes('Chef') || n.role.includes('Supplier'));
          if (chef) relevantNPC = chef;
       } else if (lowestKPI.id.includes('Satisfaction') || lowestKPI.id.includes('Reputation')) {
          const front = this.npcs.find(n => n.role.includes('Customer') || n.role.includes('Cashier') || n.role.includes('Front'));
          if (front) relevantNPC = front;
       } else if (lowestKPI.id.includes('Staff') || lowestKPI.id.includes('Morale')) {
           const sup = this.npcs.find(n => n.role.includes('Supervisor') || n.role.includes('Manager'));
           if (sup) relevantNPC = sup;
       }
    }

    const prompt = `You are a Strategy Game simulator engine.
Context:
- Industry: ${this.selectedIndustry.name}
- Role: ${this.selectedRole.name}
- Day: ${this.currentDay} of ${this.selectedDifficulty.daysToComplete}
- Daily Event: "${this.currentDailyEvent.name}" (${this.currentDailyEvent.context})
- Daily Strategy: "${this.dailyStrategy ? this.dailyStrategy.name : 'Balanced'}" (${this.dailyStrategy ? this.dailyStrategy.description : ''})
- Previous Decision Context: ${this.currentNarrativeContext || "None (First Scenario)"}
- Focus KPI: "${lowestKPI ? this.kpiDefinitions[lowestKPI.id].name : 'General Operations'}" is currently at ${lowestKPI ? lowestKPI.value : 'Stable'}%

CRITICAL INSTRUCTION: Generate a scenario that is LOGICALLY CONNECTED to the Previous Decision Context.
If the context says "Staff is tired", the new problem should be about mistakes due to fatigue.
If the context says "Kitchen is crowded", the new problem should be about safety or slow service.

The scenario MUST involve the NPC: ${relevantNPC.name} (${relevantNPC.role}, ${relevantNPC.personality}).

Current KPIs:
${Object.entries(this.kpis).map(([key, value]) => {
  const kpiInfo = this.kpiDefinitions[key];
  return `- ${kpiInfo.name} (ID: "${key}"): ${kpiInfo.unit === '$' ? '$' + Math.floor(value).toLocaleString() : Math.floor(value) + (kpiInfo.unit === 'number' ? '' : kpiInfo.unit)}`;
}).join('\n')}

IMPORTANT: When defining 'consequences', you MUST use the exact 'ID' listed above.

Task: Create a management scenario with a RANDOM question type.
Randomly select ONE type:
1. "multiple-choice" (Standard decision)
2. "true-false" (Quick judgment)
3. "matching" (Match items/concepts)
4. "priority-ranking" (Prioritize tasks)
5. "open-ended" (Management strategy)

CRITICAL RULES:
- Output ONLY valid JSON.
- No markdown, no control characters.
- Use single-line strings.

JSON Structure:
{
  "title": "Scenario Title",
  "description": "Situation description including involved characters.",
  "involvedNPCs": ["${this.npcs[0]?.id || ''}"],
  "urgency": "low|medium|high",
  "questionType": "multiple-choice|true-false|matching|priority-ranking|open-ended",
  "data": {
    // Structure depends on questionType:
    
    // IF multiple-choice:
    "options": [
      { 
        "text": "Option A", 
        "consequences": {"kpi_key": 10},
        "npcReaction": {
           "npcName": "Name of NPC reacting",
           "mood": "happy|angry|concerned|neutral",
           "dialogue": "Short, direct speech reacting to this specific decision."
        },
        "futureContext": "Short phrase describing the new state/problem caused by this choice (e.g. 'Staff is happy but equipment is breaking')"
      }
    ]

    // (Other Types follow same pattern, ensuring 'npcReaction' and 'futureContext' are included in options/outcomes)
  }
}
`;

    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let fullText = "";
      for await (const chunk of responseStream) {
        if (chunk.startsWith(fullText) && fullText.length > 0) {
          fullText = chunk; 
        } else {
          fullText += chunk;
        }
      }

      console.log("Scenario Generation:", fullText.substring(0, 200) + "...");
      const scenario = parseRelaxedJSON(fullText);

      // Validate structure
      if (!scenario.title || !scenario.questionType || !scenario.data) {
        throw new Error("Invalid scenario structure");
      }

      this.currentScenario = scenario;
      this.scenarioHistory.push({ title: scenario.title, day: this.currentDay });
      this.renderScenarioV2(scenario);

    } catch (e) {
      console.error("Scenario generation failed:", e);
      // Fallback
      const fallback = this.getFallbackScenario();
      // Adapt fallback to new structure if needed, or renderScenario will handle it
      this.currentScenario = fallback;
      this.scenarioHistory.push({ title: fallback.title, day: this.currentDay });
      this.renderScenarioV2(fallback);
    }
  }

  getFallbackScenario() {
    // Custom Industry Fallback
    if (this.isCustomIndustry && this.customKPIs) {
      const kpiKeys = Object.keys(this.customKPIs);
      const kpi1 = kpiKeys[0] || 'kpi1';
      const kpi2 = kpiKeys[1] || 'kpi2';
      
      return {
        title: "Unexpected Challenge",
        description: `An unexpected situation has arisen in your ${this.selectedIndustry.name}. The team needs your guidance on how to proceed with a critical decision regarding immediate operations.`,
        involvedNPCs: this.npcs.length > 0 ? [this.npcs[0].id] : [],
        urgency: "medium",
        options: [
          {
            text: "Invest resources to solve the problem immediately",
            consequences: { [kpi1]: -500, [kpi2]: 5 },
            outcome: "You spent resources to fix the issue quickly. The situation is resolved, improving performance but costing money."
          },
          {
            text: "Ask the team to work harder to compensate",
            consequences: { [kpi1]: 100, [kpi2]: -10 },
            outcome: "The team stepped up, saving money but increasing stress levels."
          },
          {
            text: "Take a cautious approach and observe",
            consequences: { [kpi1]: -100, [kpi2]: -5 },
            outcome: "You delayed the decision. The impact was minor but the problem persisted longer than necessary."
          }
        ]
      };
    }

    // Industry-specific fallback scenarios for pre-built industries
    const fallbacks = {
      'fast-food': {
        title: "Equipment Malfunction During Rush Hour",
        description: "It's lunch rush and one of your main cooking stations has broken down. Sarah, your shift supervisor, reports that orders are backing up and customers are getting impatient. You need to decide how to handle this crisis while maintaining service quality and customer satisfaction.",
        involvedNPCs: ["shift-supervisor"],
        urgency: "high",
        options: [
          {
            text: "Call emergency repair service immediately (expensive but fast)",
            consequences: { budget: -1500, customerSatisfaction: -5, efficiency: -10 },
            outcome: "The repair service arrives within 30 minutes and fixes the issue. You lose some money but minimize customer complaints. Staff appreciate your quick action."
          },
          {
            text: "Use backup equipment and redistribute workload among staff",
            consequences: { budget: 0, staffMorale: -10, efficiency: -15 },
            outcome: "Staff work harder to compensate, leading to some fatigue. Service is slower but you save money. A few customers complain about wait times."
          },
          {
            text: "Temporarily reduce menu options to manageable items only",
            consequences: { sales: -800, customerSatisfaction: -8, reputation: -5 },
            outcome: "You quickly adapt by offering a limited menu. Some customers are disappointed but appreciate the honesty. Service speed improves with fewer options."
          }
        ]
      },
      'retail': {
        title: "Inventory Shortage Before Weekend Sale",
        description: "Your biggest sale of the month starts tomorrow, but your main supplier just informed you that half of your advertised items won't arrive on time. Emily, your assistant manager, is worried about customer disappointment and potential complaints.",
        involvedNPCs: ["assistant-manager"],
        urgency: "high",
        options: [
          {
            text: "Find alternative suppliers at premium prices",
            consequences: { budget: -2000, customerSatisfaction: 10, reputation: 5 },
            outcome: "You secure the inventory from other suppliers at higher cost. The sale goes as planned and customers are happy, though your margins are thinner."
          },
          {
            text: "Offer rain checks and alternative products",
            consequences: { sales: -1000, customerSatisfaction: -5, staffMorale: -5 },
            outcome: "You communicate honestly with customers and offer rain checks. Some are disappointed but most appreciate the transparency. Staff deal with some complaints."
          },
          {
            text: "Postpone the sale by one week",
            consequences: { sales: -1500, reputation: -10, customerSatisfaction: -15 },
            outcome: "You delay the sale to ensure full inventory. Many customers are frustrated by the last-minute change, and some competitors benefit from your delay."
          }
        ]
      },
      'hotel': {
        title: "Overbooking Crisis",
        description: "Due to a system error, you've overbooked the hotel by 5 rooms during a major conference weekend. Lisa from the front desk has just discovered this and several guests are arriving in the next hour. You need to resolve this quickly and professionally.",
        involvedNPCs: ["front-desk"],
        urgency: "high",
        options: [
          {
            text: "Book guests at a nearby luxury hotel at your expense",
            consequences: { budget: -3000, customerSatisfaction: 5, reputation: 10 },
            outcome: "You arrange premium accommodations nearby and provide transportation. Guests are impressed by your handling of the situation, turning a negative into a positive."
          },
          {
            text: "Offer significant discounts and upgrades to volunteers who reschedule",
            consequences: { budget: -1000, customerSatisfaction: -5, efficiency: 10 },
            outcome: "Some guests agree to reschedule for generous compensation. You manage to accommodate everyone but at a cost. Most guests understand the situation."
          },
          {
            text: "Upgrade some guests to suites and use staff rooms temporarily",
            consequences: { budget: -500, staffMorale: -15, customerSatisfaction: 0 },
            outcome: "You creatively use all available space. Guests get upgrades but staff are inconvenienced. The situation is resolved but team morale takes a hit."
          }
        ]
      }
    };

    return fallbacks[this.selectedIndustry.id] || fallbacks['fast-food'];
  }

  renderScenario(scenario) {
    const urgencyColors = {
      low: 'info',
      medium: 'warning',
      high: 'danger'
    };

    const involvedNPCsHTML = scenario.involvedNPCs
      .map(npcId => this.npcs.find(n => n.id === npcId))
      .filter(npc => npc)
      .map(npc => `
        <span class="badge bg-secondary me-1">
          ${npc.avatar} ${npc.name}
        </span>
      `).join('');

    const optionsHTML = scenario.options.map((option, index) => {
      const consequencesHTML = Object.entries(option.consequences)
        .map(([key, value]) => {
          if (value === 0) return '';
          const kpiInfo = this.kpiDefinitions[key];
          if (!kpiInfo) return ''; // Skip if unknown KPI (prevents crash)
          const color = value > 0 ? 'success' : 'danger';
          const sign = value > 0 ? '+' : '';
          return `
            <span class="badge bg-${color} bg-opacity-50 me-1">
              <i class="bi ${kpiInfo.icon} me-1"></i>
              ${sign}${kpiInfo.unit === '$' ? '$' + value.toLocaleString() : value + kpiInfo.unit}
            </span>
          `;
        })
        .filter(html => html)
        .join('');

      return `
        <div class="card bg-secondary bg-opacity-25 border-secondary mb-3 option-card" 
             data-option-index="${index}"
             style="cursor: pointer; transition: all 0.3s;">
          <div class="card-body p-3">
            <div class="d-flex align-items-start mb-2">
              <div class="badge bg-primary me-2">${String.fromCharCode(65 + index)}</div>
              <div class="flex-grow-1">
                <p class="mb-2">${option.text}</p>
                <div class="small">
                  <div class="text-white-50 mb-1">Expected Impact:</div>
                  ${consequencesHTML}
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    $('#scenario-container').innerHTML = `
      <div class="mb-3">
        <div class="d-flex justify-content-between align-items-start mb-3">
          <h4 class="text-primary mb-0">
            <i class="bi bi-exclamation-circle-fill me-2"></i>
            ${scenario.title}
          </h4>
          <span class="badge bg-${urgencyColors[scenario.urgency]}">
            ${scenario.urgency.toUpperCase()} PRIORITY
          </span>
        </div>
        
        ${involvedNPCsHTML ? `
          <div class="mb-3">
            <small class="text-white-50">Involved:</small>
            ${involvedNPCsHTML}
          </div>
        ` : ''}
        
        <div class="alert alert-dark border-secondary mb-4">
          <div style="white-space: pre-wrap;">${scenario.description}</div>
        </div>
      </div>

      <div>
        <h5 class="mb-3">
          <i class="bi bi-list-check me-2"></i>
          What will you do?
        </h5>
        ${optionsHTML}
      </div>
    `;

    // Add option click handlers
    $$('.option-card').forEach(card => {
      card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateX(5px)';
        card.style.borderColor = '#0d6efd';
        card.style.backgroundColor = 'rgba(13, 110, 253, 0.1)';
      });
      card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateX(0)';
        card.style.borderColor = '';
        card.style.backgroundColor = '';
      });
      card.addEventListener('click', () => {
        this.sounds.playClick();
        const optionIndex = parseInt(card.dataset.optionIndex);
        this.handleDecision(optionIndex);
      });
    });
  }

  handleDecision(optionIndex) {
    const option = this.currentScenario.options[optionIndex];
    
    // Helper to normalize data structure across question types (future proofing)
    // For now assuming multiple-choice structure is used for basic types
    const consequences = option.consequences || {};
    const reaction = option.npcReaction || {npcName: "System", mood: "neutral", dialogue: "Decision recorded."};
    const future = option.futureContext || "";

    // 1. Update State
    this.currentNarrativeContext = future; // Store logic context for next turn

    // 2. Disable UI
    $$('.option-card').forEach(card => {
      card.style.pointerEvents = 'none';
      card.style.opacity = '0.5';
    });
    const selectedCard = $(`.option-card[data-option-index="${optionIndex}"]`);
    if(selectedCard) {
      selectedCard.style.opacity = '1';
      selectedCard.style.borderColor = '#0d6efd';
      selectedCard.style.backgroundColor = 'rgba(13, 110, 253, 0.2)';
    }

    // 3. Apply Consequences
    const multiplier = this.selectedDifficulty.consequenceSeverity;
    Object.entries(consequences).forEach(([key, value]) => {
      if (this.kpis.hasOwnProperty(key)) {
        const adjustedValue = Math.floor(value * multiplier);
        this.kpis[key] = Math.max(0, this.kpis[key] + adjustedValue);
        if (key !== 'budget' && key !== 'sales') {
          this.kpis[key] = Math.min(100, this.kpis[key]);
        }
      }
    });
    this.updateKPIsDisplay();
    this.addToActivityLog(`Decision: ${option.text.substring(0,30)}...`);

    // 4. Trigger NPC Reaction Scene (The "Show Don't Tell" Phase)
    setTimeout(() => {
      this.renderConsequenceScene(reaction, consequences);
    }, 600);
  }

  renderConsequenceScene(reaction, consequences) {
    const scenarioContainer = $('#scenario-container');
    
    // Determine mood color
    const moodColors = {
       "happy": "success",
       "excited": "success",
       "neutral": "info",
       "concerned": "warning",
       "angry": "danger",
       "annoyed": "danger"
    };
    const moodColor = moodColors[reaction.mood] || 'info';

    scenarioContainer.innerHTML = `
      <div class="d-flex flex-column justify-content-center align-items-center h-100 p-4 animate-fade-in">
        
        <!-- NPC Reaction Bubble -->
        <div class="position-relative mb-5" style="max-width: 600px;">
           <div class="card bg-dark border-${moodColor} shadow-lg" style="border-width: 2px;">
             <div class="card-body p-4 text-center">
                <div class="display-3 mb-3">${this.getAvatarByName(reaction.npcName)}</div>
                <h4 class="text-${moodColor} mb-2">${reaction.npcName}</h4>
                <div class="fs-4 fst-italic">"${reaction.dialogue}"</div>
             </div>
           </div>
           <!-- Visual stem for bubble -->
           <div class="position-absolute start-50 translate-middle-x" style="bottom: -15px; width: 0; height: 0; border-left: 15px solid transparent; border-right: 15px solid transparent; border-top: 15px solid var(--bs-${moodColor});"></div>
        </div>

        <!-- Stat Impact Summary (Small, secondary) -->
        <div class="d-flex gap-2 mb-5 justify-content-center">
           ${Object.entries(consequences).map(([k,v]) => {
              if(v === 0) return '';
              const ki = this.kpiDefinitions[k];
              const c = v > 0 ? 'success' : 'danger';
              return `<span class="badge bg-${c} bg-opacity-25 border border-${c}">${ki.name} ${v>0?'+':''}${v}</span>`;
           }).join('')}
        </div>

        <button id="next-problem-btn" class="btn btn-outline-light btn-lg px-5">
          See What Happens Next <i class="bi bi-arrow-right list-group-item-action"></i>
        </button>
      </div>
    `;

    // Add simple animation styles dynamically if not present
    if(!$('#anim-style')) {
      const style = document.createElement('style');
      style.id = 'anim-style';
      style.innerHTML = `@keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } } .animate-fade-in { animation: fadeIn 0.5s ease-out; }`;
      document.head.appendChild(style);
    }

    $('#next-problem-btn').onclick = () => {
       this.sounds.playClick();
       this.handleTurnEnd();
    };
  }

  getAvatarByName(name) {
    const npc = this.npcs.find(n => n.name === name);
    return npc ? npc.avatar : '👤';
  }

  handleTurnEnd() {
    this.questionsAnswered++; 

    if (this.currentDay >= this.selectedDifficulty.daysToComplete) {
      this.endGame();
    } else {
      // Check for NPC intrusion every 2 questions (Preserve this, but maybe context logic makes it redundant? Keeping it for "Escalations")
      if (this.questionsAnswered % 2 === 0) {
        this.triggerNPCIntrusion();
      } else {
         // Same day, new scenario (Time passes implicitly)
         // NOTE: User asked for "Strategic Timeframe". We can treat every question as advancing time slightly or significant blocks.
         this.renderGameScreen();
         this.generateScenario();
      }
    }
  }

  advanceToNextDay() {
    this.renderEndOfDayReport();
  }

  renderEndOfDayReport() {
    // 1. Calculate Economics
    // Base Revenue = Sales KPI * 100
    // Multipliers: Customer Sat (0.5 to 1.5), Reputation (0.8 to 1.2)
    const baseRevenue = (this.kpis.sales || 0) * 5 + 1000; // Guarantee some base income
    const satMult = 0.5 + (this.kpis.customerSatisfaction / 100);
    const repMult = 0.8 + (this.kpis.reputation / 250); // smaller impact
    
    const grossIncome = Math.floor(baseRevenue * satMult * repMult);

    // Expenses
    const staffCost = 2000; // Fixed daily cost
    const inventoryCost = 500 + Math.floor(grossIncome * 0.2); // COGS
    const totalExpenses = staffCost + inventoryCost;

    const netProfit = grossIncome - totalExpenses;

    const prevBudget = this.kpis.budget;
    this.kpis.budget += netProfit;

    // 2. Play Sound
    if (netProfit > 0) this.sounds.playSuccess(); else this.sounds.playError();

    // 3. Render Report
    this.container.innerHTML = `
      <div class="min-vh-100 d-flex align-items-center justify-content-center p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="card bg-dark border-light shadow-lg" style="max-width: 600px; width: 100%;">
          <div class="card-header bg-dark border-bottom border-light text-center p-4">
             <h3 class="mb-0"><i class="bi bi-moon-stars-fill text-warning me-2"></i>End of Day ${this.currentDay} Report</h3>
          </div>
          <div class="card-body p-5">
            
            <div class="row mb-4">
              <div class="col-6">
                <div class="text-white-50">Gross Revenue</div>
                <div class="fs-4 text-success">+$${grossIncome.toLocaleString()}</div>
              </div>
              <div class="col-6 text-end">
                <div class="text-white-50">Total Expenses</div>
                <div class="fs-4 text-danger">-$${totalExpenses.toLocaleString()}</div>
              </div>
            </div>

            <div class="alert alert-${netProfit >= 0 ? 'success' : 'danger'} text-center p-4 mb-4">
              <h5 class="mb-2 text-uppercase">Net Profit</h5>
              <div class="display-3 fw-bold">${netProfit >= 0 ? '+' : ''}$${netProfit.toLocaleString()}</div>
            </div>

            <div class="d-flex justify-content-between align-items-center border-top border-secondary pt-4">
              <div class="text-white-50">Updated Budget</div>
              <div class="fs-2 fw-bold text-white">$${this.kpis.budget.toLocaleString()}</div>
            </div>

          </div>
          <div class="card-footer bg-dark border-top border-light p-4">
            <button id="next-day-btn" class="btn btn-primary btn-lg w-100">
               Start Next Day <i class="bi bi-arrow-right ms-2"></i>
            </button>
          </div>
        </div>
      </div>
    `;

    $('#next-day-btn').onclick = () => {
      this.sounds.playClick();
      this.currentDay++;
      
      if (this.currentDay > this.selectedDifficulty.daysToComplete) {
         this.endGame();
      } else {
         this.renderMorningBriefing();
      }
    };
  }

  async triggerNPCIntrusion() {
    // Show loading state for intrusion
    const scenarioContainer = $('#scenario-container');
    scenarioContainer.innerHTML = `
      <div class="d-flex flex-column justify-content-center align-items-center h-100">
        <div class="spinner-border text-danger mb-3" role="status"></div>
        <h5 class="text-danger">Escalation Reported...</h5>
        <div class="text-white-50">Evaluating Situation</div>
      </div>
    `;

    // 1. Identify critical KPIs
    const sortedKPIs = Object.entries(this.kpis)
      .filter(([k]) => k !== 'budget' && k !== 'sales')
      .sort(([, a], [, b]) => a - b);
    const criticalKPI = sortedKPIs[0] ? { key: sortedKPIs[0][0], value: sortedKPIs[0][1] } : null;

    // 2. Select an NPC
    const npc = this.npcs[Math.floor(Math.random() * this.npcs.length)];

    const prompt = `You are a Game Master for a Fast Food Management Game.
Context:
- Role: ${this.selectedRole.name}
- NPC: ${npc.name} (${npc.role}, ${npc.personality})
- Critical KPI: ${criticalKPI ? criticalKPI.key + ' is at ' + criticalKPI.value : 'None'}
- Current Situation: An escalation or urgent issue has arisen.

Task: Generate an "Evaluation Event". The NPC reports a problem or asks for a decision.
The player's choice will be GRADED (A-F) based on its effectiveness.

Output JSON:
{
  "title": "Escalation Title (e.g. 'Safety Violation', 'Customer Complaint')",
  "report": "A formal or semi-formal statement of the problem by the NPC.",
  "options": [
    { 
      "text": "Action A", 
      "evaluation": {
        "grade": "A|B|C|D|F",
        "feedback": "Why this was good/bad",
        "score": 90, // 0-100
        "kpiImpact": {"kpi_key": 5}
      }
    },
    { 
      "text": "Action B", 
      "evaluation": {
        "grade": "A|B|C|D|F",
        "feedback": "Why this was good/bad",
        "score": 40,
        "kpiImpact": {"kpi_key": -5}
      }
    }
  ]
}
`;
    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let fullText = "";
      for await (const chunk of responseStream) {
         if (chunk.startsWith(fullText) && fullText.length > 0) fullText = chunk; else fullText += chunk;
      }
      
      const event = parseRelaxedJSON(fullText);
      this.renderEvaluationEvent(npc, event);

    } catch (e) {
      console.error("NPC Intrusion gen failed", e);
      this.advanceToNextDay();
    }
  }

  renderEvaluationEvent(npc, event) {
     const container = $('#scenario-container');
     
     const optionsHTML = event.options.map((opt, idx) => `
        <div class="card bg-dark border-secondary mb-3 eval-opt" data-idx="${idx}" style="cursor: pointer; transition: all 0.2s;">
          <div class="card-body p-3 d-flex align-items-center">
            <div class="badge bg-secondary me-3">${String.fromCharCode(65 + idx)}</div>
            <div class="flex-grow-1">${opt.text}</div>
            <i class="bi bi-chevron-right text-white-50"></i>
          </div>
        </div>
     `).join('');

     container.innerHTML = `
      <div class="border-start border-4 border-danger ps-4 mb-4">
        <h6 class="text-danger text-uppercase letter-spacing-2">Critical Escalation</h6>
        <h3 class="fw-bold mb-2">${event.title}</h3>
        <div class="d-flex align-items-center text-white-50 mb-3">
          <span class="me-3"><i class="bi bi-person-fill"></i> Reported by: ${npc.name} (${npc.role})</span>
        </div>
      </div>
      
      <div class="alert alert-dark border-danger mb-4 p-4">
        <i class="bi bi-quote fs-3 text-white-50"></i>
        <p class="fs-5 mb-0 fst-italic ms-3">${event.report}</p>
      </div>

      <div>
        <h6 class="text-white-50 mb-3">Select Action Plan:</h6>
        ${optionsHTML}
      </div>
     `;

    $$('.eval-opt').forEach(btn => {
      btn.addEventListener('mouseenter', () => btn.classList.add('bg-secondary', 'bg-opacity-25'));
      btn.addEventListener('mouseleave', () => btn.classList.remove('bg-secondary', 'bg-opacity-25'));
      btn.onclick = () => {
         this.sounds.playClick();
         const idx = parseInt(btn.dataset.idx);
         const selection = event.options[idx];
         this.handleEvaluationResponse(selection);
      };
    });
  }

  handleEvaluationResponse(selection) {
    const ev = selection.evaluation;
    
    // Apply impacts
    if (ev.kpiImpact) {
       Object.entries(ev.kpiImpact).forEach(([k, v]) => {
         if (this.kpis[k] !== undefined) {
           this.kpis[k] += v;
           if (k !== 'budget' && k !== 'sales') this.kpis[k] = Math.min(100, Math.max(0, this.kpis[k]));
         }
       });
       this.updateKPIsDisplay();
    }

    const gradeColor = ev.score >= 80 ? 'success' : ev.score >= 60 ? 'warning' : 'danger';
    
    const container = $('#scenario-container');
    container.innerHTML = `
      <div class="text-center p-4">
        <h5 class="text-white-50 text-uppercase mb-4">Management Review</h5>
        
        <div class="position-relative d-inline-block mb-4">
           <div style="font-size: 6rem; line-height: 1;" class="fw-bold text-${gradeColor}">
             ${ev.grade}
           </div>
           <div class="badge bg-${gradeColor} position-absolute bottom-0 start-50 translate-middle-x">
             Score: ${ev.score}/100
           </div>
        </div>

        <div class="card bg-dark border-${gradeColor} mb-4">
          <div class="card-body">
            <h6 class="card-title text-${gradeColor} mb-2">Evaluator Feedback</h6>
            <p class="card-text">${ev.feedback}</p>
          </div>
        </div>

        ${ev.kpiImpact ? `
        <div class="mb-4">
           <small class="text-white-50">Impact Analysis:</small>
           <div class="d-flex justify-content-center gap-2 mt-2">
             ${Object.entries(ev.kpiImpact).map(([k, v]) => {
                const ki = this.kpiDefinitions[k];
                const col = v > 0 ? 'success' : 'danger';
                return `<span class="badge bg-${col} bg-opacity-25 text-${col} border border-${col}">${ki.name}: ${v>0?'+':''}${v}</span>`;
             }).join('')}
           </div>
        </div>
        ` : ''}

        <button class="btn btn-primary btn-lg px-5" id="eval-continue">
          Acknowledge Review
        </button>
      </div>
    `;
    
    $('#eval-continue').onclick = () => {
       this.sounds.playClick();
       this.advanceToNextDay();
    };
  }

  updateKPIsDisplay() {
    Object.entries(this.kpis).forEach(([key, value]) => {
      const kpiInfo = this.kpiDefinitions[key];
      const element = $(`#kpi-${key}`);
      if (element) {
        const unit = kpiInfo.unit === 'number' ? '' : kpiInfo.unit;
        const displayValue = kpiInfo.unit === '$' ? '$' + Math.floor(value).toLocaleString() : Math.floor(value) + unit;
        element.textContent = displayValue;
        
        // Animate change
        element.style.transform = 'scale(1.2)';
        setTimeout(() => {
          element.style.transform = 'scale(1)';
        }, 300);
      }
    });
  }

  addToActivityLog(message) {
    const log = $('#activity-log');
    const entry = document.createElement('div');
    entry.className = 'small text-white-50 border-bottom border-secondary p-2';
    entry.innerHTML = `
      <div class="d-flex align-items-start">
        <i class="bi bi-dot me-1"></i>
        <div class="flex-grow-1">
          <div>${message}</div>
          <div class="text-white-50" style="font-size: 0.7rem;">Day ${this.currentDay}</div>
        </div>
      </div>
    `;
    log.insertBefore(entry, log.firstChild);
  }

  async talkToNPC(npc, isProactive = false) {
    const modalId = 'chat-modal-' + Date.now();
    const modalHTML = `
      <div class="modal fade" id="${modalId}" data-bs-backdrop="static">
        <div class="modal-dialog modal-dialog-centered modal-lg">
          <div class="modal-content bg-dark text-white border-secondary">
             <div class="modal-header border-secondary">
               <div>
                  <h5 class="modal-title mb-0">${npc.avatar} ${npc.name} </h5>
                  <small class="text-white-50">${npc.role}</small>
               </div>
               <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button>
             </div>
             <div class="modal-body d-flex flex-column" style="height: 50vh;">
               <div id="chat-history" class="flex-grow-1 overflow-auto mb-3 p-3 text-break d-flex flex-column gap-2 bg-black bg-opacity-25 rounded"></div>
               <div class="input-group">
                 <input type="text" id="chat-input" class="form-control bg-secondary text-white border-0" placeholder="Type a message...">
                 <button class="btn btn-primary" id="send-btn"><i class="bi bi-send-fill"></i></button>
               </div>
             </div>
          </div>
        </div>
      </div>
    `;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = modalHTML;
    const modalEl = wrapper.querySelector('.modal');
    document.body.appendChild(modalEl);
    
    const bsModal = new bootstrap.Modal(modalEl);
    bsModal.show();
    
    modalEl.addEventListener('hidden.bs.modal', () => modalEl.remove());

    const historyBox = modalEl.querySelector('#chat-history');
    const input = modalEl.querySelector('#chat-input');
    const sendBtn = modalEl.querySelector('#send-btn');

    const appendMessage = (role, text) => {
       const div = document.createElement('div');
       div.className = `p-2 rounded ${role === 'user' ? 'bg-primary align-self-end text-white' : 'bg-secondary bg-opacity-50 align-self-start text-white'}`;
       div.style.maxWidth = "80%";
       div.innerHTML = role === 'user' ? text : `<strong>${npc.name}:</strong> ${text}`;
       historyBox.appendChild(div);
       historyBox.scrollTop = historyBox.scrollHeight;
    };

    // Prevent enter overlapping
    input.addEventListener('keydown', (e) => {
        if(e.key === 'Enter') {
            e.preventDefault();
            sendBtn.click();
        }
    });

    sendBtn.onclick = async () => {
        const msg = input.value.trim();
        if(!msg) return;
        
        appendMessage('user', msg);
        input.value = '';
        input.disabled = true;
        sendBtn.disabled = true;
        
        await this.processChatTurn(npc, msg, {}, appendMessage, modalEl);
        
        input.disabled = false;
        sendBtn.disabled = false;
        input.focus();
    };

    // Initial Trigger
    const initMsg = isProactive ? "SYSTEM_PROACTIVE" : "SYSTEM_GREETING";
    // Show typing
    const typingDiv = document.createElement('div');
    typingDiv.innerHTML = `<small class="text-muted ms-2">Typing...</small>`;
    historyBox.appendChild(typingDiv);
    
    await this.processChatTurn(npc, initMsg, {}, (role, text) => {
        typingDiv.remove();
        appendMessage(role, text);
    }, modalEl);
  }

  endGame() {
    // Calculate final score
    const totalKPIs = Object.values(this.kpis).reduce((sum, val) => sum + val, 0);
    const avgKPI = totalKPIs / Object.keys(this.kpis).length;
    
    let grade = 'F';
    let gradeColor = 'danger';
    let feedback = 'Needs significant improvement';
    
    if (avgKPI >= 80) {
      grade = 'A';
      gradeColor = 'success';
      feedback = 'Excellent management skills!';
    } else if (avgKPI >= 70) {
      grade = 'B';
      gradeColor = 'info';
      feedback = 'Good performance with room for growth';
    } else if (avgKPI >= 60) {
      grade = 'C';
      gradeColor = 'warning';
      feedback = 'Adequate but needs improvement';
    } else if (avgKPI >= 50) {
      grade = 'D';
      gradeColor = 'warning';
      feedback = 'Below expectations';
    }

    this.container.innerHTML = `
      <div class="min-vh-100 d-flex align-items-center justify-content-center p-4 text-white" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="card bg-dark border-light shadow-lg" style="max-width: 800px; width: 100%;">
          <div class="card-body p-5">
            <div class="text-center mb-4">
              <h2 class="display-4 mb-3">
                <i class="bi bi-trophy-fill text-warning me-2"></i>
                Training Complete!
              </h2>
              <div class="display-1 text-${gradeColor} mb-2">${grade}</div>
              <p class="lead text-${gradeColor}">${feedback}</p>
            </div>

            <div class="alert alert-dark border-secondary mb-4">
              <h5 class="mb-3">Final Performance:</h5>
              <div class="row g-3">
                ${Object.entries(this.kpis).map(([key, value]) => {
                  const kpiInfo = this.kpiDefinitions[key];
                  const percentage = key !== 'budget' && key !== 'sales' ? value : null;
                  const color = percentage ? (percentage >= 70 ? 'success' : percentage >= 40 ? 'warning' : 'danger') : 'primary';
                  
                  return `
                    <div class="col-6">
                      <div class="d-flex justify-content-between align-items-center mb-1">
                        <span>
                          <i class="bi ${kpiInfo.icon} me-1"></i>
                          ${kpiInfo.name}
                        </span>
                        <span class="text-${color} fw-bold">
                          ${kpiInfo.unit === '$' ? '$' + Math.floor(value).toLocaleString() : Math.floor(value) + kpiInfo.unit}
                        </span>
                      </div>
                      ${percentage !== null ? `
                        <div class="progress" style="height: 6px;">
                          <div class="progress-bar bg-${color}" style="width: ${Math.min(100, Math.max(0, percentage))}%"></div>
                        </div>
                      ` : ''}
                    </div>
                  `;
                }).join('')}
              </div>
            </div>

            <div class="alert alert-info mb-4">
              <h6 class="mb-2">
                <i class="bi bi-graph-up me-2"></i>
                Training Summary:
              </h6>
              <ul class="mb-0 small">
                <li>Industry: ${this.selectedIndustry.name}</li>
                <li>Role: ${this.selectedRole.name}</li>
                <li>Difficulty: ${this.selectedDifficulty.name}</li>
                <li>Days Completed: ${this.currentDay}</li>
                <li>Scenarios Faced: ${this.scenarioHistory.length}</li>
              </ul>
            </div>

            <div class="d-grid gap-2">
              <button id="play-again-btn" class="btn btn-primary btn-lg">
                <i class="bi bi-arrow-clockwise me-2"></i>
                Train Again
              </button>
              <button id="new-setup-btn" class="btn btn-outline-light">
                <i class="bi bi-gear-fill me-2"></i>
                Try Different Role
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.sounds.playSuccess();

    $('#play-again-btn').onclick = () => {
      this.sounds.playClick();
      this.startGame();
    };

    $('#new-setup-btn').onclick = () => {
      this.sounds.playClick();
      this.gameStarted = false;
      this.renderWelcomeScreen();
    };
  }

  // --- NEW AI-DRIVEN METHODS ---

  renderScenarioV2(scenario) {
    const urgencyColors = { low: 'info', medium: 'warning', high: 'danger' };
    const urgency = scenario.urgency || 'medium';

    const involvedNPCsHTML = (scenario.involvedNPCs || [])
      .map(npcId => this.npcs.find(n => n.id === npcId))
      .filter(npc => npc)
      .map(npc => `<span class="badge bg-secondary me-1">${npc.avatar} ${npc.name}</span>`)
      .join('');

    $('#scenario-container').innerHTML = `
      <div class="mb-3">
        <div class="d-flex justify-content-between align-items-start mb-3">
          <h4 class="text-primary mb-0">
            <i class="bi bi-exclamation-circle-fill me-2"></i>
            ${scenario.title}
          </h4>
          <span class="badge bg-${urgencyColors[urgency]} text-uppercase">
            ${(urgency).toUpperCase()}
          </span>
        </div>
        
        ${involvedNPCsHTML ? `<div class="mb-3">${involvedNPCsHTML}</div>` : ''}
        
        <div class="alert alert-dark border-secondary mb-4">
          <p class="mb-0 fs-5">${scenario.description}</p>
        </div>
      </div>

      <div id="question-area"></div>
    `;

    this.renderQuestionByType(scenario, $('#question-area'));
  }

  renderQuestionByType(scenario, container) {
    const type = scenario.questionType || 'multiple-choice';
    // Normalize data: support legacy options array or new 'data' object
    const data = scenario.data || { options: scenario.options };
    
    console.log(`Rendering question type: ${type}`, data);

    switch(type) {
      case 'multiple-choice': this.renderMultipleChoice(data, container); break;
      case 'true-false': this.renderTrueFalse(data, container); break;
      case 'matching': this.renderMatching(data, container); break;
      case 'priority-ranking': this.renderPriorityRanking(data, container); break;
      case 'open-ended': this.renderOpenEnded(data, container); break;
      default: this.renderMultipleChoice(data, container);
    }
  }

  renderMultipleChoice(data, container) {
    const optionsHTML = data.options.map((option, index) => {
      // Consequences preview
      const consequencesHTML = option.consequences ? Object.entries(option.consequences)
        .filter(([key, value]) => value !== 0 && this.kpiDefinitions[key])
        .map(([key, value]) => {
          const kpiInfo = this.kpiDefinitions[key];
          const color = value > 0 ? 'success' : 'danger';
          return `<span class="badge bg-${color} bg-opacity-50 me-1"><i class="bi ${kpiInfo.icon} me-1"></i>${value > 0 ? '+' : ''}${value}</span>`;
        }).join('') : '';

      return `
        <div class="card bg-secondary bg-opacity-25 border-secondary mb-3 option-card" 
             data-index="${index}" style="cursor: pointer;">
          <div class="card-body p-3">
            <div class="d-flex align-items-center">
              <div class="badge bg-primary me-3">${String.fromCharCode(65 + index)}</div>
              <div>
                <h6 class="mb-1">${option.text}</h6>
                <div class="small">${consequencesHTML}</div>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="options-list">${optionsHTML}</div>`;

    $$('.option-card', container).forEach(card => {
      card.onclick = () => {
        // Adapt to old handleDecision
        const opt = data.options[card.dataset.index];
        this.processOutcome({
          text: opt.text,
          consequences: opt.consequences,
          outcome: opt.outcome
        });
      };
    });
  }

  renderTrueFalse(data, container) {
    container.innerHTML = `
      <div class="card bg-dark border-secondary p-4 mb-3 text-center">
        <h4 class="mb-4">"${data.statement}"</h4>
        <div class="row g-3">
          <div class="col-6">
            <button class="btn btn-success w-100 py-3" id="btn-true">
              <i class="bi bi-check-circle-fill display-6 d-block mb-2"></i>TRUE
            </button>
          </div>
          <div class="col-6">
            <button class="btn btn-danger w-100 py-3" id="btn-false">
              <i class="bi bi-x-circle-fill display-6 d-block mb-2"></i>FALSE
            </button>
          </div>
        </div>
      </div>`;

    $('#btn-true').onclick = () => this.handleBooleanAnswer(true, data);
    $('#btn-false').onclick = () => this.handleBooleanAnswer(false, data);
  }

  renderMatching(data, container) {
    let selectedLeft = null;
    let matches = {};
    const rightItems = [...data.pairs].sort(() => Math.random() - 0.5);

    const render = () => {
      const leftHTML = data.pairs.map(p => `
        <div class="card mb-2 p-2 match-left ${matches[p.left] ? 'bg-success' : (selectedLeft === p.left ? 'bg-primary' : 'bg-secondary')}" 
             data-left="${p.left}" style="cursor:pointer">
          ${p.left} ${matches[p.left] ? '<i class="bi bi-check float-end"></i>' : ''}
        </div>`).join('');

      const rightHTML = rightItems.map(p => {
        const isMatched = Object.values(matches).includes(p.right);
        return `
        <div class="card mb-2 p-2 match-right ${isMatched ? 'bg-success text-white-50' : 'bg-dark border-light'}" 
             data-right="${p.right}" style="cursor:pointer">
          ${p.right}
        </div>`;
      }).join('');

      container.innerHTML = `
        <h6 class="text-center mb-3">Match related items:</h6>
        <div class="row">
          <div class="col-6">${leftHTML}</div>
          <div class="col-6">${rightHTML}</div>
        </div>
        <button id="submit-match" class="btn btn-warning w-100 mt-3" ${Object.keys(matches).length < data.pairs.length ? 'disabled' : ''}>
          Submit Matches
        </button>
      `;
      
      this.attachMatchingEvents(data, matches, (newMatches) => {
        matches = newMatches;
        render();
      });
    };
    render();
  }

  attachMatchingEvents(data, matches, updateMatches) {
    let currentMatches = {...matches};
    let currentSelection = null;

    $$('.match-left').forEach(el => el.onclick = () => {
      if (currentMatches[el.dataset.left]) return;
      $$('.match-left').forEach(e => e.classList.remove('bg-primary'));
      el.classList.add('bg-primary');
      el.classList.remove('bg-secondary');
      currentSelection = el.dataset.left;
    });

    $$('.match-right').forEach(el => el.onclick = () => {
      if (!currentSelection && !$$('.match-left.bg-primary')[0]) return;
      // Get selection if not set but highlighted
      if (!currentSelection) currentSelection = $$('.match-left.bg-primary')[0]?.dataset.left;
      
      if (!currentSelection) return;
      if (Object.values(currentMatches).includes(el.dataset.right)) return;

      currentMatches[currentSelection] = el.dataset.right;
      updateMatches(currentMatches);
    });

    const submitBtn = $('#submit-match');
    if(submitBtn) submitBtn.onclick = () => this.handleMatchingAnswer(currentMatches, data);
  }

  renderPriorityRanking(data, container) {
    let items = [...data.items];
    
    const render = () => {
      const itemsHTML = items.map((item, i) => `
        <div class="d-flex align-items-center mb-2">
          <span class="badge bg-secondary me-2 rounded-circle">${i + 1}</span>
          <div class="card flex-grow-1 p-2 bg-dark border-secondary d-flex justify-content-between align-items-center">
            ${item}
            <div>
              <button class="btn btn-sm btn-outline-light move-up" data-idx="${i}" ${i === 0 ? 'disabled' : ''}><i class="bi bi-arrow-up"></i></button>
              <button class="btn btn-sm btn-outline-light move-down" data-idx="${i}" ${i === items.length - 1 ? 'disabled' : ''}><i class="bi bi-arrow-down"></i></button>
            </div>
          </div>
        </div>
      `).join('');

      container.innerHTML = `
        <h6 class="text-center mb-3">Rank by priority (Highest to Lowest):</h6>
        <div class="priority-list">${itemsHTML}</div>
        <button id="submit-rank" class="btn btn-warning w-100 mt-3">Confirm Order</button>
      `;

      $$('.move-up').forEach(btn => btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        [items[idx-1], items[idx]] = [items[idx], items[idx-1]];
        render();
      });

      $$('.move-down').forEach(btn => btn.onclick = () => {
        const idx = parseInt(btn.dataset.idx);
        [items[idx], items[idx+1]] = [items[idx+1], items[idx]];
        render();
      });

      $('#submit-rank').onclick = () => this.handleRankingAnswer(items, data);
    };
    render();
  }

  renderOpenEnded(data, container) {
    container.innerHTML = `
      <div class="mb-3">
        <label class="form-label text-warning h5">${data.question}</label>
        <textarea class="form-control bg-dark text-white border-secondary" id="open-answer" rows="4" placeholder="Type your management strategy..."></textarea>
      </div>
      <button id="submit-open" class="btn btn-warning w-100">Submit Strategy</button>
    `;

    $('#submit-open').onclick = () => {
      const answer = $('#open-answer').value.trim();
      if (answer.length < 10) return showAlert('warning', 'Please provide a more detailed answer.');
      this.handleOpenAnswer(answer, data);
    };
  }

  // --- ANSWER HANDLERS ---

  handleBooleanAnswer(answer, data) {
    const isCorrect = answer === data.correct;
    const consequences = isCorrect ? data.consequences.success : data.consequences.failure;
    const outcome = `You decided that the statement was ${answer ? 'TRUE' : 'FALSE'}. ${data.explanation} ${isCorrect ? 'Correct!' : 'Incorrect.'}`;
    this.processOutcome({ text: answer.toString(), consequences, outcome });
  }

  handleMatchingAnswer(matches, data) {
    let correctCount = 0;
    data.pairs.forEach(p => {
      if (matches[p.left] === p.right) correctCount++;
    });
    
    let type = 'failure';
    if (correctCount === data.pairs.length) type = 'success';
    else if (correctCount >= data.pairs.length / 2) type = 'partial';

    const consequences = data.consequences[type] || data.consequences.failure;
    const outcome = `You matched ${correctCount}/${data.pairs.length} items correctly.`;
    this.processOutcome({ text: "Matching Task", consequences, outcome });
  }

  handleRankingAnswer(userOrder, data) {
    // The correct order is derived from data.correctOrder indices mapping to the ORIGINAL items list
    // data.items may have been mutated if passed by reference, but we are inside render loop where we copy? 
    // Wait, generated JSON has "items" (list of strings) and "correctOrder" (list of indices of items in priority order).
    
    // Original items: A, B, C
    // Correct Order: [1, 2, 0] -> B is 1st, C is 2nd, A is 3rd.
    // So Correct Sequence: B, C, A.
    
    // HOWEVER, I don't have the original items list here easily if data.items was mutated.
    // But data.items comes from `renderPriorityRanking(data, ...)`
    // Inside that, I did `let items = [...data.items]`. So `data.items` is safe.
    
    const correctSequence = data.correctOrder.map(i => data.items[i]);
    
    let isCorrect = true;
    for(let i=0; i<userOrder.length; i++) {
        if (userOrder[i] !== correctSequence[i]) isCorrect = false;
    }

    const type = isCorrect ? 'success' : 'failure';
    const consequences = data.consequences[type];
    const outcome = isCorrect ? "You prioritized the tasks perfectly." : "Your prioritization was not optimal.";
    
    this.processOutcome({ text: "Priority Task", consequences, outcome });
  }

  async handleOpenAnswer(answer, data) {
    const prompt = `Evaluate answer. Q: ${data.question} Rubric: ${data.gradingRubric.join(', ')} Answer: "${answer}" Rate: excellent/good/poor. Feedback: 1 sentence. JSON: {"rating":"good","feedback":"..."}`;

    try {
        // Show loading
        $('#submit-open').innerHTML = '<span class="spinner-border spinner-border-sm"></span> Analysis...';
        
        const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
        let fullText = "";
        for await (const chunk of responseStream) fullText += chunk;
        if(fullText.includes("}{")) fullText = fullText.split("}{")[0] + "}"; // Quick stutter fix if needed
        const evalData = parseRelaxedJSON(fullText);
        
        const rating = evalData.rating.toLowerCase(); 
        const consequences = data.consequences[rating] || data.consequences.good;
        
        this.processOutcome({ 
            text: `Strategy Submitted`, 
            consequences, 
            outcome: `Analysis: ${evalData.feedback}` 
        });

    } catch(e) {
        this.processOutcome({ 
            text: "Strategy Submitted", 
            consequences: data.consequences.good, 
            outcome: "Strategy recorded." 
        });
    }
  }

  processOutcome(result) {
    // Determine visuals
    const multiplier = this.selectedDifficulty.consequenceSeverity;
    // Apply changes
    Object.entries(result.consequences).forEach(([key, value]) => {
      if (typeof value === 'number' && (this.kpis.hasOwnProperty(key) || this.kpiDefinitions[key])) {
         const kpiKey = this.kpiDefinitions[key] ? key : Object.keys(this.kpis)[0];
         if(this.kpis[kpiKey] !== undefined) {
             const adjusted = Math.floor(value * multiplier);
             this.kpis[kpiKey] = Math.max(0, this.kpis[kpiKey] + adjusted);
             
             // Cap percentage KPIs at 100 dynamically
             const def = this.kpiDefinitions[kpiKey];
             if (def && def.unit === '%') {
                this.kpis[kpiKey] = Math.min(100, this.kpis[kpiKey]);
             }
         }
      }
    });

    this.updateKPIsDisplay();
    this.addToActivityLog(`Task: ${result.text}`);
    this.showOutcomeV2(result.outcome, result.consequences);
  }

  showOutcomeV2(outcomeText, consequences) {
    const scenarioContainer = $('#scenario-container');
    
    const consequencesHTML = Object.entries(consequences)
      .filter(([_, value]) => value !== 0)
      .map(([key, value]) => {
        // Safe KPI lookup
        const kpiDef = this.kpiDefinitions[key]; 
        // Fallback to purely visual if not found, or skip?
        // Let's try to map to customKPIs if available
        const kpiInfo = kpiDef || { name: key, icon: 'bi-activity', unit: '' };
        
        const color = value > 0 ? 'success' : 'danger';
        return `
          <div class="col-6">
            <i class="bi ${kpiInfo.icon} me-1"></i>
            ${kpiInfo.name}: 
            <span class="text-${color} fw-bold">
              ${value > 0 ? '+' : ''}${value}
            </span>
          </div>`;
      }).join('');

    scenarioContainer.innerHTML = `
      <div class="text-center mb-4">
        <i class="bi bi-check-circle-fill text-success display-1 mb-3"></i>
        <h4 class="text-success mb-3">Decision Processed</h4>
      </div>

      <div class="alert alert-info mb-4">
        <h5 class="mb-2"><i class="bi bi-info-circle-fill me-2"></i>Result:</h5>
        <p class="mb-0">${outcomeText}</p>
      </div>

      <div class="alert alert-dark border-secondary mb-4">
        <h6 class="mb-2"><i class="bi bi-graph-up me-2"></i>Impact:</h6>
        <div class="row g-2 small">${consequencesHTML}</div>
      </div>

      <div class="d-grid">
        <button id="next-day-btn" class="btn btn-primary btn-lg">
          Next Day <i class="bi bi-arrow-right ms-2"></i>
        </button>
      </div>
    `;

    $('#next-day-btn').onclick = () => {
      this.sounds.playClick();
      this.advanceDay();
    };

    // Trigger proactive NPC interaction
    setTimeout(() => this.triggerRandomNPCInteraction(), 1500);
  }

  async generateDynamicNPCs(industry) {
    const prompt = `Generate 5 unique NPCs for a "${industry.name}" workplace.
    Roles: Manager, Senior, Junior, Client, Rival.
    JSON: [{"id":"n1","name":"Name","role":"Role","personality":"Trait","avatar":"👤"}]`;
    
    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let fullText = "";
      for await (const chunk of responseStream) fullText += chunk;
      const data = parseRelaxedJSON(fullText);
      return Array.isArray(data) ? data : industry.npcs; 
    } catch(e) {
      console.warn("NPC Gen Error", e);
      return industry.npcs;
    }
  }

  async triggerRandomNPCInteraction() {
     if (Math.random() > 0.3) return; // 30% chance
     const npc = this.npcs[Math.floor(Math.random() * this.npcs.length)];
     await this.talkToNPC(npc, true);
  }

  advanceDay() {
    if (this.currentDay >= this.selectedDifficulty.daysToComplete) {
      this.endGame();
    } else {
      this.currentDay++;
      this.renderGameScreen();
      this.generateScenario();
    }
  }

  async processChatTurn(npc, userMessage, context, appendMsg, modalEl) {
    const prompt = `Conversational Roleplay.
Character: ${npc.name} (${npc.role}). Personality: ${npc.personality}.
User Role: ${this.selectedRole.name}.
Current Environment: ${this.selectedIndustry.name}, Day ${this.currentDay}.
Current KPIs: ${Object.entries(this.kpis).map(([k,v]) => `${k}:${v}`).join(', ')}.

Task: valid JSON response only.
1. "reply": Your response to the user. Keep it natural, concise (max 2 sentences).
   - If User said "SYSTEM_PROACTIVE": You are INTERRUPTING with an URGENT issue/doubt.
   - If User said "SYSTEM_GREETING": Greet the user casually.
   - Otherwise: Respond to the user's message/question.
2. "kpi_impact": Any key-value changes to KPIs based on this turn (e.g., {"staffMorale": 1} if user was nice, {"reputation": -1} if user was rude). Empty {} if neutral.

Input: "${userMessage}"

Format: {"reply": "...", "kpi_impact": {}}`;

    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let fullText = "";
      for await (const chunk of responseStream) {
         if (chunk.startsWith(fullText) && fullText.length > 0) fullText = chunk; 
         else fullText += chunk;
      }
      
      let data;
      try {
        data = parseRelaxedJSON(fullText);
      } catch (e) {
        data = { reply: fullText.replace(/[*{}"]/g, '').substring(0, 100), kpi_impact: {} };
      }

      appendMsg('npc', data.reply || "...");
      
      // Apply KPIs silently
      if (data.kpi_impact && Object.keys(data.kpi_impact).length > 0) {
        Object.entries(data.kpi_impact).forEach(([k, v]) => {
           // Basic update logic
           if(this.kpis[k] !== undefined) this.kpis[k] += v;
        });
        this.updateKPIsDisplay();
        // Optional: Show small toast inside modal?
        const toast = document.createElement('div');
        toast.className = 'small text-success ms-2';
        toast.innerText = 'KPIs Updated';
        modalEl.querySelector('.modal-header').appendChild(toast);
        setTimeout(() => toast.remove(), 2000);
      }

    } catch (e) {
      console.error(e);
      appendMsg('npc', "(Connection error)");
    }
  }
}
