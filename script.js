// --- 1. Utilities ---
const $ = (s, parent = document) => parent.querySelector(s);
const $$ = (s, parent = document) => Array.from(parent.querySelectorAll(s));

// Robust JSON parser
function parseRelaxedJSON(str) {
  if (!str) {
    console.warn("parseRelaxedJSON: Empty input");
    return null;
  }
  
  let s = str.trim();
  
  // Log first 100 chars for debugging
  console.log("parseRelaxedJSON input preview:", s.substring(0, 100));
  
  // Remove markdown code blocks - handle multiple/repeated blocks
  // First, remove all standalone ``` markers
  s = s.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
  
  // Try to extract from code block if pattern exists
  const codeBlockMatch = s.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (codeBlockMatch) s = codeBlockMatch[0].trim();
  
  // More aggressive: Remove any conversational text before JSON starts
  // Look for common conversational patterns and remove everything before the JSON
  const conversationalPatterns = [
    /^.*?(?=\{)/s,  // Remove everything before first {
    /^.*?(?=\[)/s,  // Remove everything before first [
  ];
  
  // Find the valid JSON substring (Object OR Array)
  const firstOpenBrace = s.indexOf('{');
  const firstOpenBracket = s.indexOf('[');
  let startIdx = -1;
  let endIdx = -1;

  // Determine if it's likely an object or an array based on which comes first
  if (firstOpenBrace !== -1 && (firstOpenBracket === -1 || firstOpenBrace < firstOpenBracket)) {
      startIdx = firstOpenBrace;
      endIdx = s.lastIndexOf('}');
  } else if (firstOpenBracket !== -1) {
      startIdx = firstOpenBracket;
      endIdx = s.lastIndexOf(']');
  }

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    s = s.substring(startIdx, endIdx + 1);
    console.log("Extracted JSON substring, length:", s.length);
  } else {
      console.warn("No valid JSON brackets found in response");
      throw new Error("No valid JSON structure found in response");
  }
  
  // Clean up potential "stuttering" (duplicate lines) logic
  const lines = s.split('\n');
  if (lines.length > 5) { 
    const cleanedLines = [];
    const seen = new Set();
    for (const line of lines) {
      const trimmed = line.trim();
      // Allow specific structural characters 
      if (trimmed === '{' || trimmed === '}' || trimmed === '},' || trimmed === ']' || trimmed === '],' || trimmed.length < 3) {
        cleanedLines.push(line);
      } else if (!seen.has(trimmed)) {
        seen.add(trimmed);
        cleanedLines.push(line);
      }
    }
    if (cleanedLines.length < lines.length * 0.8) {
      s = cleanedLines.join('\n');
    }
  }
  
  // Remove trailing commas
  s = s.replace(/,(\s*[}\]])/g, '$1');
  
  // Fix unquoted keys (basic attempt)
  s = s.replace(/([{,]\s*)(\w+)(\s*:)/g, '$1"$2"$3');
  
  // Remove any control characters
  s = s.replace(/[\x00-\x1F\x7F]/g, '');

  // Fix positive numbers with plus sign (e.g. : +5 -> : 5)
  s = s.replace(/:\s*\+(\d+)/g, ': $1');
  
  // Attempt to fix unescaped quotes within values
  // This helps when the LLM outputs: "description": "He said "Hello" to me"
  // It's heuristic and risky but helps with common LLM errors
  s = s.replace(/:\s*"([^"]*(?:"[^"]*)*)"/g, (match, content) => {
      // Don't modify the outer quotes/structure
      return match; 
  });

  try {
    const result = JSON.parse(s);
    console.log("JSON parsed successfully");
    return result;
  } catch (e) {
    console.warn("Primary parse failed, trying relaxed approach:", e.message);
    try {
      // 1. Aggressive cleaning: newlines to spaces
      let cleaned = s.replace(/[\r\n\t]/g, ' ');
      
      // 2. Fix unescaped quotes in descriptions manually if simple check fails
      // Look for "key": "value" patterns and try to salvage
      
      const result = JSON.parse(cleaned); 
      console.log("JSON parsed successfully with relaxed approach");
      return result;
    } catch (finalError) {
      console.error("JSON Parse Failed Details:", finalError.message);
      // Last ditch: try to just return a basic error object so game doesn't crash
      throw new Error(`JSON parsing failed: ${finalError.message}. Content was: ${s.substring(0, 50)}...`);
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
    window.game = gameInstance; // Expose to window for onclick handlers
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
    console.warn("Stream failed, falling back to fetch...", e);
    try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, stream: false })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        yield data.choices?.[0]?.message?.content || "";
    } catch (fetchError) {
        console.warn("Offline Mode: LLM request failed.", fetchError.message);
        
        // Show Offline Toast only once per session to avoid spam
        if (!state.offlineToastShown) {
           showAlert('warning', 'Network Issue: Switched to Offline Simulation Mode.');
           state.offlineToastShown = true;
        }

        const lastUserMsg = history[history.length-1].content || "";
        if (lastUserMsg.includes("Generate 5 unique NPCs")) {
             yield JSON.stringify([
                 {"id":"n1","name":"Mock Manager","role":"Manager","personality":"Stoic","avatar":"👔"},
                 {"id":"n2","name":"Mock Chef","role":"Head Chef","personality":"Angry","avatar":"👨‍🍳"}
             ]);
        } else if (lastUserMsg.includes("opening story plot")) {
             yield JSON.stringify({
                 "plot_summary": "Network Offline: You are managing the store in manual mode.",
                 "opening_narrative": "The AI servers are currently unreachable. You must rely on your own instincts to run this restaurant. Good luck!"
             });
        } else if (lastUserMsg.includes("Create a management scenario")) {
             // Mock Scenario
             yield JSON.stringify({
                "title": "Network Outage",
                "description": "Communication systems are down. You need to make a decision without external data.",
                "involvedNPCs": [],
                "urgency": "high",
                "questionType": "multiple-choice",
                "data": {
                  "options": [
                    { 
                      "text": "Focus on Staff Morale", 
                      "consequences": {"staffMorale": 5},
                      "npcReaction": {"npcName": "System", "mood": "neutral", "dialogue": "Understood."},
                      "futureContext": "Staff is reassured."
                    },
                    { 
                      "text": "Focus on Efficiency", 
                      "consequences": {"efficiency": 5},
                      "npcReaction": {"npcName": "System", "mood": "neutral", "dialogue": "Speed is key."},
                      "futureContext": "Operations are faster."
                    }
                  ]
                }
             });
        } else {
             // Generic conversation/decision fallback
             yield JSON.stringify({
                 "reply": "I cannot connect to the AI brain right now. Please check your connection.",
                 "kpi_impact": {},
                 "thought_process": "Offline mode"
             });
        }
    }
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
    this.questionsAnswered = 0; // Track questions for NPC intrusion
    this.selectedIndustry = null;
    this.selectedRole = null;
    this.selectedDifficulty = null;
    this.currentDay = 1;
    this.kpis = {};
    this.npcs = [];
    this.gameLog = [];
    this.scenarioHistory = [];
    
    // Enhanced NPC System
    this.npcRelationships = {}; // Track relationship scores with each NPC
    this.npcEmotionalStates = {}; // Track current emotional state of each NPC
    this.npcMemories = {}; // Conversation history with each NPC
    this.pendingClarifications = []; // NPCs waiting to question decisions
    this.detailedDecisionHistory = []; // Track decisions with full context
    
    // Live Restaurant Simulation
    this.liveSimulation = {
      tables: [],
      activeOrders: [], 
      customerQueue: 0, 
      totalCustomersToday: 0,
      totalSalesToday: 0,
      recentChaos: null, 
      simulationInterval: null,
      eventInterval: null,
      tickCounter: 0 // Track ticks for Director
    };

    // Sales History (Mock Data for US Context)
    this.salesHistory = [
        { day: -2, amount: 1150 },
        { day: -1, amount: 1320 }
    ];

    // AI Kitchen Director State
    this.kitchenDirector = {
        lastNarrative: null,
        pendingEvents: [],
        mood: "neutral",
        contextBuffer: [] // Store short-term events for LLM context
    };

    this.prevKpis = {}; // Track history for trends
    
    // Custom industry support
    this.isCustomIndustry = false;
    this.customKPIs = null;
    this.kpiDefinitions = null;

    // Starting Scenarios
    this.selectedScenarioMode = null;
    this.startingScenarios = [
      {
        id: 'standard',
        name: 'Standard Day',
        icon: 'bi-sun',
        description: 'A typical day at the restaurant. Balanced traffic and operations.',
        effectDescription: 'Normal difficulty.',
        apply: (game) => {
           // Standard settings
           if (!game.liveSimulation.tables || game.liveSimulation.tables.length === 0) return;
           game.liveSimulation.customerQueue = 0;
           game.currentDailyEvent = { name: "Regular Tuesday", effect: "Standard operations", context: "Just another day." };
        }
      },
      {
        id: 'carnival',
        name: 'Local Carnival',
        icon: 'bi-balloon-fill',
        description: 'The town carnival is in full swing nearby! Expect chaos.',
        effectDescription: 'High queue & fast-paced.',
        apply: (game) => {
           // Only apply table logic if tables exist
           if (game.liveSimulation.tables && game.liveSimulation.tables.length > 0) {
             game.liveSimulation.customerQueue = 15;
           }
           game.currentDailyEvent = { name: "Carnival Chaos", effect: "Extreme traffic", context: "The carnival crowd is hungry!" };
           game.scenarioMultiplier = 1.5; 
        }
      },
      {
        id: 'nba',
        name: 'NBA Finals Game',
        icon: 'bi-trophy-fill',
        description: 'Huge sports event tonight. Waves of fans incoming.',
        effectDescription: 'Bursts of high traffic.',
        apply: (game) => {
           // Only apply table logic if tables exist
           if (game.liveSimulation.tables && game.liveSimulation.tables.length > 0) {
              game.liveSimulation.customerQueue = 5;
              if (game.liveSimulation.tables[0]) {
                 game.liveSimulation.tables[0].occupied = true;
                 game.liveSimulation.tables[0].customers = 4;
                 game.generateOrder(game.liveSimulation.tables[0]);
              }
           }
           game.currentDailyEvent = { name: "Game Night", effect: "Rush hours", context: "Fans are looking for a pre-game meal." };
           game.scenarioMultiplier = 1.2;
        }
      },
      {
        id: 'ipl', // KEPT ID FOR COMPATIBILITY, BUT RENAMED CONTENT
        name: 'Super Bowl Sunday', // US Replacement for IPL
        icon: 'bi-trophy',
        description: 'The Big Game is on! Everyone is glued to screens and ordering wings.',
        effectDescription: 'Constant stream of delivery & dine-in.',
        apply: (game) => {
           if (game.liveSimulation.tables && game.liveSimulation.tables.length > 0) {
             game.liveSimulation.customerQueue = 10;
           }
           game.currentDailyEvent = { name: "The Big Game", effect: "Sports Fever", context: "The match is down to the final quarter!" };
           game.scenarioMultiplier = 1.3;
        }
      },
      {
        id: 'concert',
        name: 'Music Concert',
        icon: 'bi-music-note-beamed',
        description: 'A massive rock concert just finished at the stadium nearby.',
        effectDescription: 'Sudden massive queue spike.',
        apply: (game) => {
           if (game.liveSimulation.tables && game.liveSimulation.tables.length > 0) {
             game.liveSimulation.customerQueue = 20; // Big rush
           }
           game.currentDailyEvent = { name: "Post-Concert Rush", effect: "Hungry Fans", context: "Thousands of fans are flooding the streets." };
           game.scenarioMultiplier = 1.4;
        }
      },
      {
        id: 'diwali', // KEPT ID, RENAMED CONTENT
        name: 'Christmas Eve', // US Replacement for Diwali
        icon: 'bi-snow',
        description: 'Families are gathering for a cozy holiday meal.',
        effectDescription: 'Large groups, high expectations.',
        apply: (game) => {
           if (game.liveSimulation.tables && game.liveSimulation.tables.length > 0) {
             game.liveSimulation.customerQueue = 8;
           }
           game.currentDailyEvent = { name: "Christmas Eve", effect: "Holiday Spirit", context: "Snow is falling, and the mood is festive." };
           game.scenarioMultiplier = 1.25;
           // Boost morale initially
           game.kpis.staffMorale = Math.min(100, (game.kpis.staffMorale || 50) + 10);
        }
      }
    ];
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
        this.renderScenarioSelection();
      });
    });

    $('#back-btn').onclick = () => {
      this.sounds.playClick();
      this.renderIndustrySelection();
    };
  }

  renderScenarioSelection() {
    const scenariosHTML = this.startingScenarios.map(scen => `
      <div class="col-md-4 mb-3">
        <div class="card bg-dark border-secondary h-100 scenario-card" 
             data-scenario="${scen.id}"
             style="cursor: pointer; transition: all 0.3s;">
          <div class="card-body p-4 text-center">
            <i class="bi ${scen.icon} display-4 text-info mb-3"></i>
            <h5 class="card-title text-white mb-2">${scen.name}</h5>
            <p class="card-text text-white-50 small mb-3 text-wrap">${scen.description}</p>
            <div class="badge bg-dark border border-info text-info p-2 text-wrap lh-sm">
              ${scen.effectDescription}
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
              <i class="bi bi-calendar-event me-2"></i>
              Choose Starting Scenario
            </h2>
            <p class="text-white-50">This determines the initial conditions of your restaurant.</p>
          </div>

          <div class="row justify-content-center">
            ${scenariosHTML}
          </div>

          <div class="text-center mt-5">
            <button id="back-btn" class="btn btn-outline-light">
              <i class="bi bi-arrow-left me-2"></i>Back
            </button>
          </div>
        </div>
      </div>
    `;

    $$('.scenario-card').forEach(card => {
        card.addEventListener('mouseenter', () => {
        card.style.transform = 'translateY(-5px)';
        card.style.borderColor = '#0dcaf0';
        card.style.boxShadow = '0 5px 20px rgba(13, 202, 240, 0.3)';
        });
        card.addEventListener('mouseleave', () => {
        card.style.transform = 'translateY(0)';
        card.style.borderColor = '';
        card.style.boxShadow = '';
        });
        card.addEventListener('click', () => {
        this.sounds.playClick();
        const sId = card.dataset.scenario;
        this.selectedScenarioMode = this.startingScenarios.find(s => s.id === sId);
        this.renderDifficultySelection();
        });
    });

    $('#back-btn').onclick = () => {
        this.sounds.playClick();
        this.renderRoleSelection();
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
      this.renderScenarioSelection();
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
                  <div class="fw-bold">${this.selectedDifficulty.levelsToComplete} Levels</div>
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
                Start Game
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

  async initializeStory() {
  // Use scenario-specific context if available
  const scenarioCtx = this.selectedScenarioMode ? 
     `Starting Scenario: ${this.selectedScenarioMode.name} - ${this.selectedScenarioMode.description}.` : 
     "Standard operations.";

  const prompt = `Create a short, engaging opening story plot for a game where the user plays as a ${this.selectedRole.name} in the ${this.selectedIndustry.name} industry.
  ${scenarioCtx}
  Current Situation: Starting a new job/position.
  KPIs: ${Object.entries(this.selectedRole.startingKPIs).map(([k,v]) => `${k}:${v}`).join(', ')}.
  
  Output JSON format:
  {
    "plot_summary": "One sentence summary reflecting the ${this.selectedScenarioMode ? this.selectedScenarioMode.name : 'situation'}",
    "opening_narrative": "A paragraph describing the scene. It MUST mention the '${this.selectedScenarioMode ? this.selectedScenarioMode.name : 'situation'}' details (e.g. crowds, noise, event)."
  }`;
  
  try {
     const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
     let fullText = "";
     for await (const chunk of responseStream) {
       // Snapshot detection: if chunk starts with fullText, it's a resend
       if (chunk.startsWith(fullText) && fullText.length > 0) {
         fullText = chunk;
       } else {
         fullText += chunk;
       }
     }
     
     if (!fullText || !fullText.trim()) {
        console.warn("Empty response from LLM for story initialization");
        throw new Error("Empty response");
     }

     let data;
     try {
       data = parseRelaxedJSON(fullText);
     } catch (e) {
       // If JSON fails but we have text, assume text is the narrative
       data = { plot_summary: "Starting a new venture.", opening_narrative: fullText };
     }
     
     if (!data) {
        data = { plot_summary: "Starting a new venture.", opening_narrative: "You have arrived at your new workplace." };
     }

     this.storyline = [{ 
       type: 'initial', 
       summary: data.plot_summary || "New Beginnings", 
       text: data.opening_narrative || "You have just started your new role."
     }];

     // Show the story immediately
     this.container.innerHTML = `
      <div class="min-vh-100 d-flex flex-column justify-content-center align-items-center text-white p-5" 
           style="background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);">
        <div class="card bg-dark border-light shadow-lg" style="max-width: 800px;">
          <div class="card-body p-5">
            <h2 class="text-warning mb-4"><i class="bi bi-book me-2"></i>The Story Begins...</h2>
            <div class="lead mb-4 text-white" style="line-height: 1.8;">
              ${data.opening_narrative || fullText || "Welcome to the game."}
            </div>
            <button id="story-continue-btn" class="btn btn-primary btn-lg">
              <i class="bi bi-arrow-right me-2"></i>Continue
            </button>
          </div>
        </div>
      </div>
     `;
     
     await new Promise(resolve => {
        const btn = document.getElementById('story-continue-btn');
        if(btn) btn.onclick = resolve;
        else resolve();
     });

  } catch (e) {
     console.warn("Story Init Error", e);
     this.storyline = [{ type: 'initial', summary: "New Job", text: "You have arrived at your new workplace." }];
  }
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
        const scenarioCtx = this.selectedScenarioMode ? `Scenario: ${this.selectedScenarioMode.name} - ${this.selectedScenarioMode.description}` : "";
        this.npcs = await this.generateDynamicNPCs(this.selectedIndustry, scenarioCtx);
      } catch (e) {
        this.npcs = [...this.selectedIndustry.npcs];
      }
    }
    
    // Initialize NPC Memory, Relationships, and Emotional States
    this.npcMemories = {};
    this.npcRelationships = {};
    this.npcEmotionalStates = {};
    this.npcs.forEach(n => {
        if(!n.id) n.id = n.name.toLowerCase().replace(/\s/g, '-');
        this.npcMemories[n.id] = [];
        this.npcRelationships[n.id] = n.baseRelationship || 50; // 0-100 scale
        this.npcEmotionalStates[n.id] = 'neutral'; // Start neutral
    });

    this.currentDay = 1;
    this.gameLog = [];
    this.scenarioHistory = [];
    this.storyline = [];
    
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

    // Initialize Story Plot
    await this.initializeStory();

    // Apply Scenario Effects BEFORE rendering briefing/game
    if (this.selectedScenarioMode && this.selectedScenarioMode.apply) {
        // Initialize simple liveSim structure if not yet ready, but it is reset in startNewDay... 
        // Actually startNewDay calls initializeLiveSimulation which resets tables.
        // We need to apply scenario AFTER initializeLiveSimulation OR modify variables that persist.
        // Since startNewDay is called after Briefing, we should apply scenario effects THERE or set flags.
        // But `this.currentDailyEvent` is used in Briefing. So we set that here.
        this.selectedScenarioMode.apply(this);
    }

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
    this.initializeLiveSimulation(); // Start the live restaurant simulation
    
    // Re-apply scenario specific table/order states if this is Day 1
    if (this.currentDay === 1 && this.selectedScenarioMode && this.selectedScenarioMode.apply) {
        this.selectedScenarioMode.apply(this);
        this.updateTablesDisplay();
        this.updateOrdersDisplay();
        this.updateCustomerCount();
    }

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
              <small class="text-white-50">Level ${this.currentDay} of ${this.selectedDifficulty.levelsToComplete}</small>
            </div>
            
            <div class="col-auto text-end">
               <div class="badge bg-warning text-dark mb-1"><i class="bi bi-trophy me-1"></i> ${this.currentDailyEvent.name}</div>
               <div class="small text-white-50" style="font-size: 0.75rem;">${this.currentDailyEvent.context}</div>
            </div>

            <div class="col-auto">
              <div class="progress" style="width: 200px; height: 8px;">
                <div class="progress-bar bg-success" style="width: ${(this.currentDay / this.selectedDifficulty.levelsToComplete) * 100}%"></div>
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

        <!-- Live Restaurant Activity (Collapsible Removed) --> 
        <!-- Logic moved to sidebar -->

        <!-- Main Content Area: 3-Column Layout -->
        <div class="container-fluid">
          <div class="row">
            
            <!-- Left Column: Team & Manager's Log -->
            <div class="col-lg-3 mb-3">
               <!-- Team Card -->
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
                      <div class="fs-4 me-2">${npc.avatar}</div>
                      <div class="flex-grow-1">
                        <div class="fw-bold small">${npc.name}</div>
                        <div class="text-white-50" style="font-size: 0.7rem;">${npc.role}</div>
                      </div>
                      <i class="bi bi-chat-dots text-primary small"></i>
                    </div>
                  `).join('')}
                </div>
              </div>
              
              <!-- Manager's Log -->
              <div class="card bg-dark border-light" style="min-height: 300px;">
                <div class="card-header bg-transparent border-bottom border-secondary">
                  <h6 class="mb-0">
                    <i class="bi bi-clock-history me-2"></i>
                    Suggestions
                  </h6>
                </div>
                <div class="card-body p-2" id="activity-log" style="min-height: 250px; max-height: 400px; overflow-y: auto; font-family: monospace; font-size: 0.85rem;">
                  <div class="small text-white-50 text-center p-3">
                    Game started.
                  </div>
                </div>
              </div>
            </div>

            <!-- Center Column: Current Situation -->
            <div class="col-lg-6 mb-3">
              <!-- Scenario Panel -->
              <div class="card bg-dark border-light" style="min-height: 600px;">
                <div class="card-header bg-transparent border-bottom border-secondary">
                  <h5 class="mb-0">
                    <i class="bi bi-newspaper me-2"></i>
                    Current Situation
                  </h5>
                </div>
                <div class="card-body" id="scenario-container" style="min-height: 550px; max-height: auto; overflow-y: auto;">
                  <div class="d-flex justify-content-center align-items-center h-100">
                    <div class="spinner-border text-primary" role="status">
                      <span class="visually-hidden">Loading...</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Right Column: Kitchen Activity -->
            <div class="col-lg-3">
              <div class="card bg-dark border-warning mb-3">
                <div class="card-header bg-transparent border-warning d-flex justify-content-between align-items-center">
                   <h6 class="mb-0 text-warning"><i class="bi bi-broadcast me-2"></i>Kitchen Activity</h6>
                   <span class="badge bg-warning text-dark" id="live-customer-count">
                     ${(this.liveSimulation && this.liveSimulation.tables) ? this.liveSimulation.tables.reduce((acc, t) => acc + (t.occupied ? t.customers : 0), 0) : 0} cust
                   </span>
                </div>
                <div class="card-body p-2">
                   <!-- Tables Small Grid -->
                   <div class="mb-2">
                     <div class="small text-white-50 mb-1"><i class="bi bi-table me-1"></i>Tables</div>
                     <div class="d-flex flex-wrap gap-1" id="tables-status"></div>
                   </div>
                   
                   <!-- Active Orders -->
                   <div class="mb-2">
                     <div class="small text-white-50 mb-1"><i class="bi bi-receipt me-1"></i>Orders</div>
                     <div id="active-orders" style="max-height: 150px; overflow-y: auto;"></div>
                   </div>

                   <!-- Live Feed -->
                   <div>
                     <div class="small text-white-50 mb-1"><i class="bi bi-activity me-1"></i>Log</div>
                     <div id="live-feed" 
                          class="bg-black bg-opacity-50 rounded p-2" 
                          style="max-height:400px; overflow-y: auto; font-size: 0.75rem; font-family: monospace; line-height: 1.2;">
                     </div>
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

  // ===== LIVE RESTAURANT SIMULATION =====
  
  initializeLiveSimulation() {
    // Only initialize tables if they don't exist (preserve state across levels)
    if (!this.liveSimulation.tables || this.liveSimulation.tables.length === 0) {
        // Initialize tables (12 tables for a small restaurant)
        this.liveSimulation.tables = Array.from({length: 12}, (_, i) => ({
          id: i + 1,
          occupied: false,
          customers: 0,
          order: null,
          timeSeated: null
        }));
        this.addToLiveFeed('Restaurant opened for business!', 'success');
    } else {
        this.addToLiveFeed('Operations continuing...', 'info');
    }
    
    this.updateTablesDisplay();
    
    // Start simulation loops
    if (this.liveSimulation.simulationInterval) clearInterval(this.liveSimulation.simulationInterval);
    this.liveSimulation.simulationInterval = setInterval(() => this.runSimulationTick(), 1000); 
  }

  stopLiveSimulation() {
    if (this.liveSimulation.simulationInterval) {
      clearInterval(this.liveSimulation.simulationInterval);
    }
  }

  runSimulationTick() {
    this.liveSimulation.tickCounter++;

    // Basic Logic: Steady Customer Flow (don't rely solely on LLM)
    this.handleCustomerArrivalLogic();

    // --- AI SIMULATION UPDATE (Every ~5 seconds) ---
    // User wants LLM to manage EVERYTHING. So we slow down the logic loop 
    // and let the LLM decide arrivals, progress, and incidents.
    if (this.liveSimulation.tickCounter % 5 === 0) {
        this.runKitchenDirector();
    }

    // --- AI PERFORMANCE LOG (Every 60 seconds) ---
    if (this.liveSimulation.tickCounter % 60 === 0) {
        this.generatePerformanceLog('periodic');
    }
  }

  async generatePerformanceLog(trigger = "periodic") {
    // Prevent spam if offline
    if (this.llmOffline) return;

    const stats = this.liveSimulation.tables ? 
        `Customers: ${this.liveSimulation.totalCustomersToday}, active tables: ${this.liveSimulation.tables.filter(t=>t.occupied).length}/12` : 
        "Shop closed";
    const kpis = Object.entries(this.kpis).map(([k,v]) => `${k}:${Math.floor(v)}`).join(', ');
    
    const prompt = `
    You are the manager's assistant.
    Current Status: ${stats}.
    Key Metrics: ${kpis}.
    Trigger: ${trigger}
    
    Task: Write a ONE-SENTENCE log entry evaluating performance.
    Examples:
    - "Kitchen is slowing down, we need to boost efficiency."
    - "Customers are happy, sales are climbing steady."
    - "That last decision really helped our reputation."
    
    Output JUST the sentence.
    `;

    try {
        const stream = await this.askLLM([{role: 'user', content: prompt}]);
        let text = "";
        for await (const chunk of stream) {
            if (chunk.startsWith(text)) text = chunk; else text += chunk;
        }
        if (text && text.trim()) {
            this.addToActivityLog(`📝 ${text.trim()}`, 'info');
        }
    } catch (e) {
        // Silent fail
    }
  }



  processOrders() {
     // No-op: LLM controls cooking progress in runKitchenDirector
  }
  
  checkCustomerDepartures() {
     // Kept as fallback cleanup, but mainly LLM should trigger departures
     // We can just check for long-sitting tables if LLM forgets them?
     // For now, let's leave independent departure logic disabled or minimal.
  }

  handleCustomerArrivalLogic() {
    const arrivalChance = 0.4; // 40% chance per tick
    const efficiency = this.kpis.efficiency || 65;
    const reputation = this.kpis.reputation || 60;
    
    // Higher efficiency and reputation = more customers
    // Apply Scenario Multiplier if present
    const scenarioMult = this.scenarioMultiplier || 1.0;
    const adjustedChance = arrivalChance * (reputation / 60) * (efficiency / 65) * scenarioMult;
    
    if (Math.random() < adjustedChance) {
      this.handleCustomerArrival();
    }
  }

  handleCustomerArrival() {
    const partySize = Math.random() < 0.7 ? Math.floor(Math.random() * 2) + 2 : Math.floor(Math.random() * 4) + 1; // 2-3 people usually, sometimes 1-4
    
    // Find available table
    const availableTable = this.liveSimulation.tables.find(t => !t.occupied);
    
    if (availableTable) {
      availableTable.occupied = true;
      availableTable.customers = partySize;
      availableTable.timeSeated = Date.now();
      
      this.liveSimulation.totalCustomersToday += partySize;
      
      // Generate order after a delay
      setTimeout(() => this.generateOrder(availableTable), Math.random() * 2000 + 1000);
      
      this.addToLiveFeed(`👥 Party of ${partySize} seated at Table ${availableTable.id}`, 'info');
      
      // Update customer count
      this.updateCustomerCount();
    } else {
      this.liveSimulation.customerQueue++;
      this.addToLiveFeed(`⏳ ${partySize} customers waiting (no tables available)`, 'warning');
      
      // Negative impact on satisfaction if queue builds up
      if (this.liveSimulation.customerQueue > 3) {
        this.kpis.customerSatisfaction = Math.max(0, this.kpis.customerSatisfaction - 1);
        this.updateKPIsDisplay();
      }
    }
  }

  generateOrder(table) {
    if (!table.occupied) return;
    
    const menuItems = [
      {name: 'Burger Combo', price: 12, uses: {burgerPatties: 1, friesStock: 1, beverageSyrup: 1, packagingSupplies: 1}},
      {name: 'Chicken Sandwich', price: 10, uses: {chickenBreasts: 1, friesStock: 1, packagingSupplies: 1}},
      {name: 'Fries & Drink', price: 6, uses: {friesStock: 2, beverageSyrup: 1, packagingSupplies: 1}},
      {name: 'Double Burger', price: 15, uses: {burgerPatties: 2, friesStock: 1, beverageSyrup: 1, packagingSupplies: 1}},
      {name: 'Chicken Nuggets', price: 8, uses: {chickenBreasts: 1, packagingSupplies: 1}}
    ];
    
    // Generate order for each customer
    const orderItems = [];
    let totalPrice = 0;
    
    for (let i = 0; i < table.customers; i++) {
      const item = menuItems[Math.floor(Math.random() * menuItems.length)];
      orderItems.push(item);
      totalPrice += item.price;
    }
    
    const order = {
      tableId: table.id,
      items: orderItems,
      totalPrice,
      status: 'pending',
      placedAt: Date.now()
    };
    
    table.order = order;
    this.liveSimulation.activeOrders.push(order);
    
    this.addToLiveFeed(`📝 Table ${table.id} ordered: ${orderItems.map(i => i.name).join(', ')} ($${totalPrice})`, 'info');
    this.updateOrdersDisplay();
    
    // Start cooking - STOPPED JS AUTO START
    // setTimeout(() => this.cookOrder(order), Math.random() * 3000 + 2000);
    // LLM will trigger 'start_cooking' update
  }

  // cookOrder removed/deprecated as direct call, now controlled by LLM update action
  // keeping serveOrder for utility

  /* cookOrder(order) { ... removed ... } */

  serveOrder(order) {
    if (order.status !== 'cooking') return;
    
    order.status = 'served';
    
    // Add to sales
    this.kpis.sales = (this.kpis.sales || 0) + order.totalPrice;
    this.kpis.budget = (this.kpis.budget || 0) + order.totalPrice;
    this.liveSimulation.totalSalesToday += order.totalPrice;
    
    this.addToLiveFeed(`✅ Table ${order.tableId} served! +$${order.totalPrice}`, 'success');
    this.updateKPIsDisplay();
    
    // Remove from active orders
    const index = this.liveSimulation.activeOrders.indexOf(order);
    if (index > -1) {
      this.liveSimulation.activeOrders.splice(index, 1);
    }
    
    this.updateOrdersDisplay();
    
    // Customers will leave after eating - STOPPED JS AUTO LEAVE
    // setTimeout(() => this.handleCustomerDeparture(order.tableId), Math.random() * 3000 + 2000);
    // LLM will trigger 'leave' update
  }

  handleCustomerDeparture(tableId) {
    const table = this.liveSimulation.tables.find(t => t.id === tableId);
    if (!table || !table.occupied) return;
    
    const satisfaction = this.kpis.customerSatisfaction || 75;
    const timeSpent = Date.now() - table.timeSeated;
    
    // If service was too slow, reduce satisfaction
    if (timeSpent > 30000) { // More than 30 seconds in simulation time
      this.kpis.customerSatisfaction = Math.max(0, satisfaction - 2);
      this.addToLiveFeed(`😐 Table ${tableId} left (slow service)`, 'warning');
    } else {
      // Small chance of positive feedback
      if (Math.random() < 0.3) {
        this.kpis.customerSatisfaction = Math.min(100, satisfaction + 1);
        this.kpis.reputation = Math.min(100, (this.kpis.reputation || 60) + 0.5);
        this.addToLiveFeed(`😊 Table ${tableId} left happy!`, 'success');
      } else {
        this.addToLiveFeed(`👋 Table ${tableId} left`, 'secondary');
      }
    }
    
    // Clear table
    table.occupied = false;
    table.customers = 0;
    table.order = null;
    table.timeSeated = null;
    
    // Seat waiting customers if any
    if (this.liveSimulation.customerQueue > 0) {
      this.liveSimulation.customerQueue--;
      setTimeout(() => this.handleCustomerArrival(), 500);
    }
    
    this.updateCustomerCount();
    this.updateTablesDisplay();
    this.updateKPIsDisplay();
  }

  checkCustomerDepartures() {
    // Randomly check if any served customers are ready to leave
    this.liveSimulation.tables.forEach(table => {
      if (table.occupied && table.order && table.order.status === 'served') {
        if (Math.random() < 0.3) { // 30% chance per tick
          this.handleCustomerDeparture(table.id);
        }
      }
    });
  }

  processOrders() {
    // Check for stuck orders (quality issues)
    const staffMorale = this.kpis.staffMorale || 70;
    const equipmentCondition = this.kpis.equipmentCondition || 80;
    
    this.liveSimulation.activeOrders.forEach(order => {
      if (order.status === 'cooking') {
        const timeCooking = Date.now() - order.placedAt;
        
        // Base mistake chance (human error) + Morale/Equipment factors
        let mistakeChance = 0.02; // 2% base chance per tick
        if (staffMorale < 60) mistakeChance += 0.05;
        if (equipmentCondition < 60) mistakeChance += 0.05;
        if (this.liveSimulation.activeOrders.length > 8) mistakeChance += 0.05; // Overwhelmed

        // If cooking too long, chance increases drastically
        if (timeCooking > 12000) mistakeChance += 0.1;

        if (Math.random() < mistakeChance) { 
          this.addToLiveFeed(`🔥 Order for Table ${order.tableId} burned! Remaking...`, 'danger');
          this.liveSimulation.recentChaos = "Burned Food";
          
          this.kpis.wastePercentage = Math.min(100, (this.kpis.wastePercentage || 12) + 2);
          this.kpis.customerSatisfaction = Math.max(0, this.kpis.customerSatisfaction - 2);
          
          // Reset cooking time (remake)
          order.placedAt = Date.now(); 
          
          this.updateKPIsDisplay();
        }
      }
    });
  }

  async generateLiveEvent() {
    // LLM generates random events based on current state
    const currentState = {
      occupiedTables: this.liveSimulation.tables.filter(t => t.occupied).length,
      totalTables: this.liveSimulation.tables.length,
      activeOrders: this.liveSimulation.activeOrders.length,
      customerQueue: this.liveSimulation.customerQueue,
      salesToday: this.liveSimulation.totalSalesToday,
      customersToday: this.liveSimulation.totalCustomersToday,
      staffMorale: this.kpis.staffMorale,
      efficiency: this.kpis.efficiency,
      burgerPatties: this.kpis.burgerPatties,
      chickenBreasts: this.kpis.chickenBreasts
    };
    
    // Only generate events occasionally and if there's activity
    if (Math.random() > 0.4 || currentState.occupiedTables === 0) return;
    
    const prompt = `You are simulating a live restaurant. Current state:
- ${currentState.occupiedTables}/${currentState.totalTables} tables occupied
- ${currentState.activeOrders} active orders
- ${currentState.customerQueue} customers waiting
- $${currentState.salesToday} sales today
- ${currentState.customersToday} customers served
- Staff morale: ${currentState.staffMorale}%
- Efficiency: ${currentState.efficiency}%
- Burger patties: ${currentState.burgerPatties} units
- Chicken: ${currentState.chickenBreasts} units

Generate a SHORT, realistic restaurant event (1 sentence). Examples:
- "A customer compliments the chef on the burger quality"
- "The fryer is making unusual noises"
- "A family with kids just walked in"
- "Someone left a 5-star review on their phone"
- "The lunch rush is starting to pick up"

Output ONLY the event text, no JSON, no quotes.`;

    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let eventText = "";
      for await (const chunk of responseStream) {
        if (chunk.startsWith(eventText) && eventText.length > 0) {
          eventText = chunk;
        } else {
          eventText += chunk;
        }
      }
      
      eventText = eventText.trim().replace(/^["']|["']$/g, ''); // Remove quotes
      if (eventText && eventText.length < 150) {
        this.addToLiveFeed(`📢 ${eventText}`, 'info');
      }
    } catch (e) {
      // Silently fail for live events
      console.log('Live event generation skipped');
    }
  }

  // Display update functions
  updateTablesDisplay() {
    const tablesContainer = $('#tables-status');
    if (!tablesContainer) return;
    
    tablesContainer.innerHTML = this.liveSimulation.tables.map(table => {
      const color = table.occupied ? 'danger' : 'success';
      const icon = table.occupied ? '🔴' : '🟢';
      return `<div class="badge bg-${color} bg-opacity-50" title="Table ${table.id}: ${table.occupied ? table.customers + ' customers' : 'Available'}">${icon} ${table.id}</div>`;
    }).join('');
  }

  updateOrdersDisplay() {
    const ordersContainer = $('#active-orders');
    if (!ordersContainer) return;
    
    if (this.liveSimulation.activeOrders.length === 0) {
      ordersContainer.innerHTML = '<div class="text-white-50 text-center py-2">No active orders</div>';
    } else {
      ordersContainer.innerHTML = this.liveSimulation.activeOrders.map(order => {
        // Updated Status Colors for better contrast
        const statusColors = {pending: 'info', cooking: 'primary', served: 'success'}; // 'info' is Cyan, better than warning (yellow)
        const statusIcons = {pending: '⏳', cooking: '🔥', served: '✅'};
        // Use text-dark for info badge to ensure readability, or white if using dark theme
        const textColor = order.status === 'pending' ? 'text-dark' : 'text-white';
        
        return `<div class="d-flex justify-content-between align-items-center mb-1 p-1 bg-secondary bg-opacity-25 rounded" style="font-size: 0.7rem;">
          <span class="text-truncate" style="max-width: 120px;">${statusIcons[order.status]} Table ${order.tableId}</span>
          <span class="badge bg-${statusColors[order.status]} ${textColor}">${order.status}</span>
        </div>`;
      }).join('');
    }
  }

  updateDecisionHistory(decisionText) {
    const historyContainer = $('#decision-history');
    if (!historyContainer) return;
    
    const entry = document.createElement('div');
    entry.className = 'text-white-50 mb-1';
    entry.innerHTML = `<i class="bi bi-check-circle text-success me-1"></i>${decisionText}`;
    historyContainer.insertBefore(entry, historyContainer.firstChild);
    
    // Keep only last 5 entries
    while (historyContainer.children.length > 5) {
      historyContainer.removeChild(historyContainer.lastChild);
    }
  }

  updateCustomerCount() {
    const countBadge = $('#live-customer-count');
    if (!countBadge) return;
    
    const currentCustomers = this.liveSimulation.tables
      .filter(t => t.occupied)
      .reduce((sum, t) => sum + t.customers, 0);
    
    countBadge.textContent = `${currentCustomers} customer${currentCustomers !== 1 ? 's' : ''}`;
  }

  async runKitchenDirector() {
    // Gather Complete State for LLM Control
    const activeOrdersShort = this.liveSimulation.activeOrders.map(o => `T${o.tableId}:${o.status}`).join(',');
    const occupiedTables = this.liveSimulation.tables.filter(t => t.occupied).length;
    const queue = this.liveSimulation.customerQueue;
    const stats = `Tables:${occupiedTables}/12, Queue:${queue}, Active:${activeOrdersShort}`;
    const scenario = this.selectedScenarioMode ? this.selectedScenarioMode.name : "Standard";
    
    const contextLogs = this.kitchenDirector.contextBuffer.join('; ');
    this.kitchenDirector.contextBuffer = []; 

    const prompt = `You are the AI KITCHEN ENGINE. 
    Context: ${scenario}. Stats: ${stats}.
    Recent: ${contextLogs}.
    
    TASK: SIMULATE the next 10 minutes of restaurant operations.
    Decide ON YOUR OWN:
    1. New Arrivals: How many people walk in?
    2. Order Updates: Which pending orders start cooking? Which cooking orders finish?
    3. Departures: Which served tables leave?
    4. Incidents/Atmosphere: Any problems or flavor text?

    OUTPUT JSON ONLY:
    {
      "arrivals": 0 to 5 (people),
      "updates": [
         {"tableId": 1, "action": "start_cooking"}, 
         {"tableId": 2, "action": "finish_cooking"},
         {"tableId": 3, "action": "leave"}
      ],
      "narrative": "One sentence atmosphere",
      "event": {"type": "incident_type", "desc": "description"} (optional)
    }`;

    try {
        const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
        let fullText = "";
        for await (const chunk of responseStream) {
             if (chunk.startsWith(fullText)) fullText = chunk; else fullText += chunk;
        }

        const data = parseRelaxedJSON(fullText);
        this.applyLLMSimulation(data);

    } catch(e) {
        console.warn("Sim Engine offline:", e);
    }
  }

  applyLLMSimulation(data) {
      if(!data) return;

      // 1. Narrative
      if(data.narrative) this.addToLiveFeed(data.narrative, 'director');

      // 2. Arrivals
      if (data.arrivals > 0) {
          const groupSize = Math.max(1, Math.min(6, data.arrivals));
          this.handleLLMCustomerArrival(groupSize);
      }

      // 3. Updates
      if (data.updates && Array.isArray(data.updates)) {
          data.updates.forEach(update => {
             const table = this.liveSimulation.tables.find(t => t.id === update.tableId);
             const order = this.liveSimulation.activeOrders.find(o => o.tableId === update.tableId);
             
             if (!table) return;

             switch(update.action) {
                 case 'start_cooking':
                     if(order && order.status === 'pending') {
                         order.status = 'cooking';
                         this.addToLiveFeed(`🔥 Chef starts Table ${table.id}`, 'primary');
                     }
                     break;
                 case 'finish_cooking':
                     if(order && order.status === 'cooking') {
                         this.serveOrder(order); // Uses existing logic for logic but controlled by LLM timing
                     }
                     break;
                 case 'leave':
                     this.handleCustomerDeparture(table.id);
                     break;
             }
          });
      }

      // 4. Events
      if(data.event) this.handleDirectorEvent(data.event);

      // Refresh UI
      this.updateTablesDisplay();
      this.updateOrdersDisplay();
  }

  handleLLMCustomerArrival(size) {
    const table = this.liveSimulation.tables.find(t => !t.occupied);
    if(table) {
        table.occupied = true;
        table.customers = size;
        table.timeSeated = Date.now();
        this.addToLiveFeed(`👥 Party of ${size} seated at Table ${table.id}`, 'info');
        // Auto-generate order details (menu items) via JS helper, but timing controlled by LLM's next 'start_cooking'
        this.generateOrder(table); 
    } else {
        this.liveSimulation.customerQueue += size;
        this.addToLiveFeed(`⏳ ${size} customers added to waiting list`, 'warning');
    }
  }

  handleDirectorEvent(event) {
      if(!event || !event.type) return;

      switch(event.type) {
          case 'minor_accident':
              this.addToLiveFeed(`💥 ${event.desc}`, 'danger');
              this.kpis.efficiency = Math.max(0, this.kpis.efficiency - 2);
              break;
          case 'staff_bark':
              const speaker = this.npcs[Math.floor(Math.random()*this.npcs.length)];
              this.addToLiveFeed(`🗣️ ${speaker.name}: "${event.desc}"`, 'info');
              break;
          case 'equipment_glitch':
              this.addToLiveFeed(`⚠️ ${event.desc}`, 'warning');
              // Pause random cooking order
              const cooking = this.liveSimulation.activeOrders.find(o => o.status === 'cooking');
              if(cooking) {
                  cooking.progress = Math.max(0, cooking.progress - 20); // Setback
              }
              break;
          case 'customer_complaint':
              this.addToLiveFeed(`😠 ${event.desc}`, 'danger');
              this.kpis.reputation -= 1;
              break;
          case 'smooth_sailing':
              this.addToLiveFeed(`✨ ${event.desc}`, 'success');
              this.kpis.staffMorale = Math.min(100, this.kpis.staffMorale + 1);
              break;
           case 'rush_hour':
              this.addToLiveFeed(`🔥 ${event.desc}`, 'warning');
              this.scenarioMultiplier = (this.scenarioMultiplier || 1) * 1.2;
              setTimeout(() => this.scenarioMultiplier /= 1.2, 20000); // 20s boost
              break;
      }
      this.updateKPIsDisplay();
  }

  addToLiveFeed(message, type = 'secondary') {
    // Buffer for AI Director
    if (this.kitchenDirector && this.kitchenDirector.contextBuffer) {
        if(this.kitchenDirector.contextBuffer.length < 5) { // Keep buffer small
            this.kitchenDirector.contextBuffer.push(message);
        }
    }

    const feed = $('#live-feed');
    if (!feed) return;
    
    const entry = document.createElement('div');

    // Style mapping
    const styles = {
        'info': 'text-info',
        'warning': 'text-warning',
        'danger': 'text-danger',
        'success': 'text-success',
        'director': 'text-white fst-italic border-start border-3 border-primary ps-2 my-1' // Special style for AI
    };
    
    const time = new Date().toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"});
    
    if (type === 'director') {
        entry.innerHTML = `<span class="opacity-50 small">[${time}]</span> ${message}`;
        entry.className = styles['director'];
    } else {
        entry.innerHTML = `<span class="opacity-50 small">[${time}]</span> <span class="${styles[type] || 'text-white'}">${message}</span>`;
        entry.className = 'mb-1 text-wrap'; // Ensure wrapping
    }

    feed.insertBefore(entry, feed.firstChild);
    
    // Keep feed clean
    if (feed.children.length > 20) {
        feed.removeChild(feed.lastChild);
    }
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
    const criticalKPIs = Object.entries(this.kpis)
      .filter(([k]) => k !== 'budget' && k !== 'sales')
      .sort(([, a], [, b]) => a - b);
    const lowestKPI = criticalKPIs[0] ? { id: criticalKPIs[0][0], value: criticalKPIs[0][1] } : null;

    // 2. Select Relevant NPC based on KPI category and NPC expertise
    let relevantNPC = null;
    
    if (lowestKPI) {
      const kpiInfo = this.kpiDefinitions[lowestKPI.id];
      const kpiCategory = kpiInfo?.category || 'operations';
      
      // Map KPI categories and specific KPIs to expertise areas
      const expertiseMap = {
        // Inventory items -> food/inventory experts
        'burgerPatties': ['food quality', 'inventory management', 'supply chain'],
        'chickenBreasts': ['food quality', 'inventory management', 'supply chain'],
        'friesStock': ['food quality', 'inventory management', 'supply chain'],
        'beverageSyrup': ['inventory management', 'supply chain'],
        'packagingSupplies': ['inventory management', 'supply chain'],
        
        // Customer-facing KPIs
        'customerSatisfaction': ['customer service', 'customer interaction', 'customer perspective'],
        'reputation': ['customer service', 'customer perspective', 'community sentiment'],
        
        // Staff KPIs
        'staffMorale': ['staff scheduling', 'compliance', 'staff management'],
        
        // Operations KPIs
        'efficiency': ['operations', 'workflow'],
        'equipmentCondition': ['equipment maintenance', 'safety compliance'],
        'wastePercentage': ['food quality', 'operations', 'cost-saving repairs']
      };
      
      // Get relevant expertise areas for this KPI
      const relevantExpertise = expertiseMap[lowestKPI.id] || [];
      
      // Find NPCs with matching expertise, excluding external stakeholders for internal issues
      const internalRoles = ['Chef', 'Supervisor', 'Manager', 'Lead', 'Technician'];
      const externalRoles = ['Customer', 'Client', 'Supplier'];
      
      // For internal operations, only use internal NPCs
      const isInternalIssue = ['inventory', 'staff', 'operations'].includes(kpiCategory) || 
                              lowestKPI.id.includes('Morale') || 
                              lowestKPI.id.includes('efficiency') ||
                              lowestKPI.id.includes('equipment') ||
                              lowestKPI.id.includes('waste');
      
      let candidateNPCs = this.npcs.filter(npc => {
        // Filter out external stakeholders for internal issues
        if (isInternalIssue) {
        if (isInternalIssue) {
          const isExternal = externalRoles.some(role => npc.role.includes(role)) || npc.role.toLowerCase().includes('rival');
          if (isExternal) return false;
        }
        }
        
        // Check if NPC has relevant expertise
        if (npc.expertise && relevantExpertise.length > 0) {
          return npc.expertise.some(exp => 
            relevantExpertise.some(reqExp => 
              exp.toLowerCase().includes(reqExp.toLowerCase()) ||
              reqExp.toLowerCase().includes(exp.toLowerCase())
            )
          );
        }
        
        // Fallback: check role keywords
        if (lowestKPI.id.includes('Patties') || lowestKPI.id.includes('Chicken') || lowestKPI.id.includes('Fries')) {
          return npc.role.includes('Chef') || npc.role.includes('Supplier');
        }
        if (lowestKPI.id.includes('Satisfaction') || lowestKPI.id.includes('Reputation')) {
          return npc.role.includes('Lead') || npc.role.includes('Supervisor');
        }
        if (lowestKPI.id.includes('Staff') || lowestKPI.id.includes('Morale')) {
          return npc.role.includes('Supervisor') || npc.role.includes('Manager');
        }
        if (lowestKPI.id.includes('equipment')) {
          return npc.role.includes('Technician') || npc.role.includes('Maintenance');
        }
        
        return false;
      });
      
      // If we found matching NPCs, pick one (prefer higher relationship)
      if (candidateNPCs.length > 0) {
        // Sort by relationship (higher is better for constructive scenarios)
        candidateNPCs.sort((a, b) => (this.npcRelationships[b.id] || 50) - (this.npcRelationships[a.id] || 50));
        relevantNPC = candidateNPCs[0];
      }
    }
    
    // Fallback: if no relevant NPC found, pick an internal staff member (not customer/client)
    // Fallback: if no relevant NPC found, pick an internal staff member
    if (!relevantNPC) {
      const internalNPCs = this.npcs.filter(npc => 
        !npc.role.toLowerCase().includes('customer') && 
        !npc.role.toLowerCase().includes('client') &&
        !npc.role.toLowerCase().includes('rival') &&
        !npc.role.toLowerCase().includes('competitor')
      );
      relevantNPC = internalNPCs.length > 0 ? 
        internalNPCs[Math.floor(Math.random() * internalNPCs.length)] : 
        this.npcs[0]; 
    }


    // Build detailed KPI status with specific values and warnings
    const kpiStatus = Object.entries(this.kpis).map(([key, value]) => {
      const kpiInfo = this.kpiDefinitions[key];
      let status = 'normal';
      let statusEmoji = '✓';
      
      if (kpiInfo.inverted) {
        // For inverted KPIs like waste (lower is better)
        if (kpiInfo.criticalHigh && value >= kpiInfo.criticalHigh) {
          status = 'CRITICAL';
          statusEmoji = '🔴';
        } else if (kpiInfo.warningHigh && value >= kpiInfo.warningHigh) {
          status = 'WARNING';
          statusEmoji = '⚠️';
        }
      } else {
        // For normal KPIs (higher is better)
        if (kpiInfo.criticalLow && value <= kpiInfo.criticalLow) {
          status = 'CRITICAL';
          statusEmoji = '🔴';
        } else if (kpiInfo.warningLow && value <= kpiInfo.warningLow) {
          status = 'WARNING';
          statusEmoji = '⚠️';
        }
      }
      
      const formattedValue = kpiInfo.unit === '$' ? '$' + Math.floor(value).toLocaleString() : Math.floor(value) + kpiInfo.unit;
      return `${statusEmoji} ${kpiInfo.name} (ID: "${key}"): ${formattedValue} [${status}]`;
    }).join('\n');

    // Build NPC context with relationships, emotional states, and decision memory
    const npcContext = this.npcs.map(npc => {
      const relationship = this.npcRelationships[npc.id] || 50;
      const emotionalState = this.npcEmotionalStates[npc.id] || 'neutral';
      const relationshipDesc = relationship >= 70 ? 'Trusting' : relationship >= 40 ? 'Professional' : 'Strained';
      
      // Get recent decisions involving this NPC
      const npcMemory = this.npcMemories[npc.id] || [];
      const recentDecisions = npcMemory
        .filter(m => m.type === 'decision')
        .slice(-3) // Last 3 decisions
        .map(m => `  Day ${m.day}: \"${m.scenario}\" - You chose: \"${m.decision.substring(0, 60)}${m.decision.length > 60 ? '...' : ''}\"`)
        .join('\n');
      
      const memorySection = recentDecisions ? `
  Recent Decisions Involving ${npc.name}:
${recentDecisions}` : '';
      
      return `- ${npc.name} (${npc.role}): Relationship ${relationship}/100 (${relationshipDesc}), Currently ${emotionalState}
  Personality: ${npc.personality}
  Expertise: ${npc.expertise ? npc.expertise.join(', ') : 'General'}
  Communication Style: ${npc.communicationStyle || 'Professional'}${memorySection}`;
    }).join('\n\n');

    const prompt = `You are an advanced Strategy Game simulator creating HIGHLY DETAILED, SPECIFIC scenarios.

GAME CONTEXT:
- Industry: ${this.selectedIndustry.name}
- Your Role: ${this.selectedRole.name}
- Day: ${this.currentDay} of ${this.selectedDifficulty.daysToComplete}
- Daily Event: "${this.currentDailyEvent.name}" (${this.currentDailyEvent.context})
- Daily Strategy: "${this.dailyStrategy ? this.dailyStrategy.name : 'Balanced'}" (${this.dailyStrategy ? this.dailyStrategy.description : ''})
- Previous Decision Outcome: ${this.currentNarrativeContext || "None (First Scenario)"}
- Story Arc: ${this.storyline ? this.storyline.slice(-3).map(s => s.summary).join(' → ') : "Starting"}

DETAILED KPI STATUS:
${kpiStatus}

NPC TEAM STATUS:
${npcContext}

LIVE KITCHEN STATUS:
- Active Orders: ${this.liveSimulation.activeOrders.length}
- Customer Queue: ${this.liveSimulation.customerQueue}
- Recent Chaos: ${this.liveSimulation.recentChaos || "None"}

CRITICAL INSTRUCTIONS FOR SCENARIO CREATION:

1. **BE EXTREMELY SPECIFIC**: Instead of "inventory is low", say "We only have 237 burger patties left, which won't last through lunch rush. We normally use 400 during peak hours."

2. **USE EXACT NUMBERS**: Reference actual KPI values. If chicken stock is at 180 units and critical is 100, mention "180 chicken breasts remaining, dangerously close to our 100-unit emergency threshold."

3. **CONNECT TO PREVIOUS CONTEXT**: The scenario MUST be a logical consequence of the previous decision. If context says "Staff is exhausted from overtime", create a scenario about mistakes, accidents, or complaints due to fatigue.

4. **NPC PERSONALITY INTEGRATION**: The NPC should speak and act according to their personality and current emotional state. Reference their expertise and concerns.

5. **RELATIONSHIP AWARENESS**: NPCs with high relationship (70+) will be supportive and give benefit of doubt. NPCs with low relationship (40-) will be critical and question decisions.

6. **STAY WITHIN EXPERTISE**: The NPC should ONLY discuss topics within their expertise areas. Do NOT have them comment on unrelated issues:
   - Customers/Clients: Can discuss customer satisfaction, service quality, reputation
   - Chefs: Food quality, inventory, operations, waste
   - Supervisors: Staff morale, compliance, scheduling, customer service
   - Suppliers: Supply chain, pricing, delivery, product quality
   - Technicians: Equipment, maintenance, safety
   
7. **INCLUDE CLARIFICATION OPPORTUNITY**: After presenting the scenario, the NPC should offer to answer questions or provide more details if needed. This allows the player to seek clarification.

The scenario MUST involve: ${relevantNPC.name} (${relevantNPC.role})
Their expertise: ${relevantNPC.expertise ? relevantNPC.expertise.join(', ') : 'General'}
Current relationship with you: ${this.npcRelationships[relevantNPC.id]}/100
Current emotional state: ${this.npcEmotionalStates[relevantNPC.id]}

IMPORTANT: When defining 'consequences', you MUST use the exact KPI 'ID' from the status list above.

Task: Create a management scenario with a RANDOM question type.
Randomly select ONE type:
1. "multiple-choice" (Standard decision with 3-4 options)
2. "true-false" (Quick judgment call)
3. "priority-ranking" (Rank 4-5 tasks by urgency)
4. "open-ended" (Explain your management strategy)

CRITICAL RULES:
- Output ONLY valid JSON
- No markdown, no code blocks, no explanations
- Use single-line strings (no newlines in string values)
- Be SPECIFIC with numbers, names, and details
- ESCAPE any internal quotes in descriptions (e.g., "She said \\"Hello\\"")

JSON Structure:

JSON Structure:
{
  "title": "Specific Scenario Title (e.g., 'Burger Patty Shortage: 237 Units Remaining')",
  "description": "Detailed situation with SPECIFIC numbers, names, and context. Include what the NPC is saying/reporting. Mention they're available for questions if you need clarification.",
  "involvedNPCs": ["${relevantNPC.id}"],
  "urgency": "low|medium|high",
  "questionType": "multiple-choice|true-false|priority-ranking|open-ended",
  "npcCanQuestionDecision": true,
  "data": {
    // IF multiple-choice:
    "options": [
      { 
        "text": "Specific action with details (e.g., 'Order 1,000 burger patties from Rodriguez for rush delivery ($450 premium)')", 
        "consequences": {"burgerPatties": 1000, "budget": -450, "relationship_supplier": 5},
        "npcReaction": {
           "npcName": "${relevantNPC.name}",
           "mood": "happy|concerned|frustrated|neutral",
           "dialogue": "Character-specific response in their communication style, reacting to THIS specific choice",
           "relationshipChange": -5 to +10
        },
        "futureContext": "Specific outcome state (e.g., 'Inventory restocked but budget tight, Rodriguez expects future orders')",
        "mayTriggerClarification": true
      }
    ]
    // IF true-false:
    // "statement": "Statement to evaluate",
    // "correct": true,
    // "explanation": "Why it is true/false",
    // "consequences": { "success": {...}, "failure": {...} }

    // IF open-ended:
    // "question": "Strategic question to ask",
    // "gradingRubric": ["Reasoning", "Impact awareness", "Tone"],
    // "consequences": { "good": {...}, "average": {...}, "poor": {...} }

    // IF priority-ranking:
    // "items": ["Task A", "Task B", "Task C"],
    // "correctOrder": [0, 2, 1], // Indices of items in correct order
    // "consequences": { "success": {...}, "failure": {...} }

  }
}`;


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

    // 1. Record Decision in Detailed History
    const decisionRecord = {
      day: this.currentDay,
      scenarioTitle: this.currentScenario.title,
      decisionText: option.text,
      consequences: consequences,
      npcReaction: reaction,
      futureContext: future,
      timestamp: Date.now(),
      involvedNPCs: this.currentScenario.involvedNPCs || []
    };
    this.detailedDecisionHistory.push(decisionRecord);
    
    // Update Decision History Display
    this.updateDecisionHistory(option.text.substring(0, 40) + (option.text.length > 40 ? '...' : ''));
    
    // 2. Update State
    this.currentNarrativeContext = future; // Store logic context for next turn

    // 3. Disable UI
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

    // 4. Apply Consequences
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

    // 5. Update NPC Memory - NPCs remember decisions that involved them
    if (this.currentScenario.involvedNPCs) {
      this.currentScenario.involvedNPCs.forEach(npcId => {
        if (!this.npcMemories[npcId]) this.npcMemories[npcId] = [];
        this.npcMemories[npcId].push({
          type: 'decision',
          scenario: this.currentScenario.title,
          decision: option.text,
          reaction: reaction.npcName === this.npcs.find(n => n.id === npcId)?.name ? reaction.dialogue : null,
          day: this.currentDay
        });
      });
    }

    // 6. Trigger NPC Reaction Scene (The "Show Don't Tell" Phase)
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
         let change = v;
         // Diminishing returns: Harder to gain as you get higher
         if (change > 0 && k !== 'budget' && k !== 'sales') {
            const headroom = 100 - this.kpis[k];
            const factor = Math.max(0.2, headroom / 60); 
            change = change * factor;
         }
         this.kpis[k] += change;
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
    const prev = this.prevKpis[key] !== undefined ? this.prevKpis[key] : value;

    if (element) {
      const unit = kpiInfo.unit === 'number' ? '' : kpiInfo.unit;
      const displayValue = kpiInfo.unit === '$' ? '$' + Math.floor(value).toLocaleString() : Math.floor(value) + unit;
      
      // Trend Arrow
      let arrow = '';
      if (value > prev) arrow = ' <span class="text-success small">↑</span>';
      else if (value < prev) arrow = ' <span class="text-danger small">↓</span>';

      element.innerHTML = displayValue + arrow;
      
      // Animate change
      if (value !== prev) {
        element.style.transform = 'scale(1.2)';
        element.classList.add(value > prev ? 'text-success' : 'text-danger');
        
        setTimeout(() => {
          element.style.transform = 'scale(1)';
          element.classList.remove('text-success', 'text-danger'); // Revert to original color logic which is handled by renderGameScreen usually, but here we might overrule it momentarily
        }, 300);
      }
    }
    this.prevKpis[key] = value;
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
    const rubric = data.gradingRubric ? data.gradingRubric.join(', ') : 'General Management Principles';
    const question = data.question || 'Strategy Decision';
    const prompt = `Evaluate answer. Q: ${question} Rubric: ${rubric} Answer: "${answer}" Rate: excellent/good/poor. Feedback: 1 sentence. JSON: {"rating":"good","feedback":"..."}`;

    try {
        // Show loading
        $('#submit-open').innerHTML = '<span class="spinner-border spinner-border-sm"></span> Analysis...';
        
        const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
        let fullText = "";
        for await (const chunk of responseStream) {
          // Snapshot detection: if chunk starts with fullText, it's a resend
          if (chunk.startsWith(fullText) && fullText.length > 0) {
            fullText = chunk;
          } else {
            fullText += chunk;
          }
        }
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

  async advanceToNextDay() {
    this.stopLiveSimulation();

    // Generate Level Review using LLM
    const sales = this.liveSimulation.totalSalesToday;
    const history = this.detailedDecisionHistory.slice(-5).map(d => `- ${d.text} (Result: ${d.impact})`).join('\n');
    
    // Store daily Record
    this.salesHistory = this.salesHistory || [];
    this.salesHistory.push({day: this.currentDay, amount: sales});

    // Level completed - no popup, just continue

    this.currentDay++;
    // Cumulative stats - do not reset
    // this.liveSimulation.totalCustomersToday = 0;
    // this.liveSimulation.totalSalesToday = 0;
    
    this.detailedDecisionHistory = [];

    if (this.currentDay > this.selectedDifficulty.levelsToComplete) {
      this.endGame(true);
    } else {
      this.startNewDay(); // Skip morning briefing, go straight to game
    }
  }



  processOutcome(result) {
    // Determine visuals
    const multiplier = this.selectedDifficulty.consequenceSeverity;
    
    // Store detailed decision for history
    this.detailedDecisionHistory.push({
      day: this.currentDay,
      decision: result.text,
      consequences: {...result.consequences},
      context: result.futureContext,
      timestamp: Date.now()
    });
    
    // Apply KPI changes
    Object.entries(result.consequences).forEach(([key, value]) => {
      if (typeof value === 'number' && (this.kpis.hasOwnProperty(key) || this.kpiDefinitions[key])) {
        
        let finalValue = value;
        // Diminishing returns for positive gains
        if (finalValue > 0 && key !== 'budget' && key !== 'sales') {
            const current = this.kpis[key] || 50;
            const factor = Math.max(0.2, (110 - current) / 60);
            finalValue = finalValue * factor;
        }

        this.kpis[key] = (this.kpis[key] || 0) + finalValue;
        
        // Cap at 0-100 for non-resource KPIs
        if (key !== 'budget' && key !== 'sales') {
          this.kpis[key] = Math.min(100, Math.max(0, this.kpis[key]));
        }
      }
    });

    // Handle NPC relationship changes
    // Handle NPC relationship changes
    if (result.npcReaction) {
      const npcId = this.npcs.find(n => n.name === result.npcReaction.npcName)?.id;
      if (npcId && result.npcReaction.relationshipChange) {
        const oldRelationship = this.npcRelationships[npcId] || 50;
        this.npcRelationships[npcId] = Math.max(0, Math.min(100, oldRelationship + result.npcReaction.relationshipChange));
        
        // Update emotional state based on mood
        if (result.npcReaction.mood) {
          this.npcEmotionalStates[npcId] = result.npcReaction.mood;
        }
        
        console.log(`${result.npcReaction.npcName} relationship: ${oldRelationship} -> ${this.npcRelationships[npcId]}`);
      }
    }
    
    // Generate AI Commentary on this decision
    this.generatePerformanceLog("decision_made");

    this.updateKPIsDisplay();
    this.addToActivityLog(`Task: ${result.text}`);
    
    // Update Storyline
    if (result.futureContext) {
        if(!this.storyline) this.storyline = [];
        this.storyline.push({
            type: 'decision',
            summary: result.text.substring(0, 50),
            text: result.futureContext
        });
        this.currentNarrativeContext = result.futureContext;
    }

    // Check if NPC wants to question this decision
    if (result.mayTriggerClarification && Math.random() < 0.3) {
      // 30% chance NPC will ask for clarification
      const npcId = this.npcs.find(n => n.name === result.npcReaction?.npcName)?.id;
      if (npcId) {
        this.pendingClarifications.push({
          npcId,
          decision: result.text,
          context: result.futureContext
        });
      }
    }

    this.showOutcomeV2(result.outcome || result.futureContext || "Outcome Applied", result.consequences, result.npcReaction);
  }

  showOutcomeV2(outcomeText, consequences, npcReaction) {
    const scenarioContainer = $('#scenario-container');
    
    const consequencesHTML = Object.entries(consequences)
      .filter(([_, value]) => value !== 0)
      .map(([key, value]) => {
        // Safe KPI lookup
        const kpiDef = this.kpiDefinitions[key]; 
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

    // NPC Reaction section
    let npcReactionHTML = '';
    if (npcReaction && npcReaction.dialogue) {
      const npc = this.npcs.find(n => n.name === npcReaction.npcName);
      const moodColors = {
        happy: 'success',
        neutral: 'secondary',
        concerned: 'warning',
        frustrated: 'danger',
        angry: 'danger'
      };
      const moodColor = moodColors[npcReaction.mood] || 'secondary';
      const relationshipChange = npcReaction.relationshipChange || 0;
      const relationshipText = relationshipChange > 0 ? 
        `<span class="text-success">+${relationshipChange} relationship</span>` : 
        relationshipChange < 0 ? 
        `<span class="text-danger">${relationshipChange} relationship</span>` : '';

      npcReactionHTML = `
        <div class="alert alert-${moodColor} border-${moodColor} mb-4">
          <div class="d-flex align-items-start">
            <div class="fs-1 me-3">${npc?.avatar || '👤'}</div>
            <div class="flex-grow-1">
              <h6 class="mb-1">
                <strong>${npcReaction.npcName}</strong> 
                <span class="badge bg-${moodColor} ms-2">${npcReaction.mood}</span>
                ${relationshipText ? `<span class="ms-2 small">${relationshipText}</span>` : ''}
              </h6>
              <p class="mb-0">"${npcReaction.dialogue}"</p>
            </div>
          </div>
        </div>
      `;
    }

    // Check for pending clarifications
    const hasPendingClarification = this.pendingClarifications.length > 0;
    const clarificationButtonHTML = hasPendingClarification ? `
      <button id="clarification-btn" class="btn btn-warning btn-lg mb-2">
        <i class="bi bi-question-circle me-2"></i>
        ${this.npcs.find(n => n.id === this.pendingClarifications[0].npcId)?.name} wants to discuss this decision
      </button>
    ` : '';

    scenarioContainer.innerHTML = `
      <div class="text-center mb-4">
        <i class="bi bi-check-circle-fill text-success display-1 mb-3"></i>
        <h4 class="text-success mb-3">Decision Processed</h4>
      </div>

      ${npcReactionHTML}

      <div class="alert alert-info mb-4">
        <h5 class="mb-2"><i class="bi bi-info-circle-fill me-2"></i>Result:</h5>
        <p class="mb-0">${outcomeText}</p>
      </div>

      <div class="alert alert-dark border-secondary mb-4">
        <h6 class="mb-2"><i class="bi bi-graph-up me-2"></i>Impact:</h6>
        <div class="row g-2 small">${consequencesHTML}</div>
      </div>

      <div class="d-grid gap-2">
        ${clarificationButtonHTML}
        <button id="next-day-btn" class="btn btn-primary btn-lg">
          Next Level <i class="bi bi-arrow-right ms-2"></i>
        </button>
      </div>
    `;

    if (hasPendingClarification) {
      $('#clarification-btn').onclick = () => {
        this.sounds.playClick();
        this.handleNPCClarification();
      };
    }

    $('#next-day-btn').onclick = () => {
      this.sounds.playClick();
      this.advanceToNextDay();
    };

    // Trigger proactive NPC interaction
    setTimeout(() => this.triggerRandomNPCInteraction(), 1500);
  }

  async handleNPCClarification() {
    if (this.pendingClarifications.length === 0) return;
    
    const clarification = this.pendingClarifications.shift(); // Get and remove first clarification
    const npc = this.npcs.find(n => n.id === clarification.npcId);
    if (!npc) return;

    const relationship = this.npcRelationships[npc.id] || 50;
    const emotionalState = this.npcEmotionalStates[npc.id] || 'neutral';
    
    // Show loading state
    const scenarioContainer = $('#scenario-container');
    scenarioContainer.innerHTML = `
      <div class="text-center p-5">
        <div class="spinner-border text-warning mb-3" style="width: 3rem; height: 3rem;"></div>
        <h5>${npc.name} is formulating their question...</h5>
      </div>
    `;

    // Generate NPC's question using LLM
    const prompt = `You are ${npc.name}, a ${npc.role} with this personality: ${npc.personality}

Your communication style: ${npc.communicationStyle || 'Professional'}
Your current emotional state: ${emotionalState}
Your relationship with the manager: ${relationship}/100 (${relationship >= 70 ? 'Trusting' : relationship >= 40 ? 'Professional' : 'Strained'})
Your expertise: ${npc.expertise ? npc.expertise.join(', ') : 'General management'}

The manager just made this decision: "${clarification.decision}"
The outcome was: "${clarification.context}"

Based on your personality and expertise, you want to question or seek clarification about this decision.

Generate a response with:
1. Your specific question or concern about the decision
2. What additional information you need
3. Optionally suggest an alternative approach

Be in character. If relationship is high, be supportive but curious. If low, be more critical.

Output ONLY valid JSON:
{
  "question": "Your specific question about the decision",
  "concern": "What worries you or what you don't understand",
  "suggestedAlternative": "Optional: What you think might work better (can be null)",
  "tone": "supportive|curious|concerned|critical"
}`;

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

      const npcQuestion = parseRelaxedJSON(fullText);
      
      // Display the clarification interface
      this.renderClarificationInterface(npc, npcQuestion, clarification);

    } catch (e) {
      console.error("Clarification generation failed:", e);
      // Skip to next day if failed
      this.advanceToNextDay();
    }
  }

  renderClarificationInterface(npc, npcQuestion, clarification) {
    const scenarioContainer = $('#scenario-container');
    
    const toneColors = {
      supportive: 'success',
      curious: 'info',
      concerned: 'warning',
      critical: 'danger'
    };
    const toneColor = toneColors[npcQuestion.tone] || 'warning';

    scenarioContainer.innerHTML = `
      <div class="border-start border-4 border-${toneColor} ps-4 mb-4">
        <h6 class="text-${toneColor} text-uppercase letter-spacing-2">
          <i class="bi bi-question-circle-fill me-2"></i>
          Clarification Request
        </h6>
        <div class="d-flex align-items-start mb-3">
          <div class="fs-1 me-3">${npc.avatar}</div>
          <div class="flex-grow-1">
            <h5 class="mb-1">${npc.name} <span class="badge bg-${toneColor}">${npcQuestion.tone}</span></h5>
            <small class="text-white-50">${npc.role} • Relationship: ${this.npcRelationships[npc.id]}/100</small>
          </div>
        </div>
      </div>

      <div class="alert alert-${toneColor} border-${toneColor} mb-4">
        <h6 class="mb-2"><i class="bi bi-chat-quote me-2"></i>Their Question:</h6>
        <p class="mb-3">"${npcQuestion.question}"</p>
        
        <h6 class="mb-2"><i class="bi bi-exclamation-triangle me-2"></i>Their Concern:</h6>
        <p class="mb-0">${npcQuestion.concern}</p>
        
        ${npcQuestion.suggestedAlternative ? `
          <hr class="my-3">
          <h6 class="mb-2"><i class="bi bi-lightbulb me-2"></i>Their Suggestion:</h6>
          <p class="mb-0">${npcQuestion.suggestedAlternative}</p>
        ` : ''}
      </div>

      <div class="alert alert-dark mb-4">
        <h6 class="mb-2">Your Decision Was:</h6>
        <p class="mb-0">"${clarification.decision}"</p>
      </div>

      <div class="mb-4">
        <label class="form-label text-white">
          <i class="bi bi-reply me-2"></i>
          <strong>Your Response / Explanation:</strong>
        </label>
        <textarea 
          id="clarification-response" 
          class="form-control bg-dark text-white border-secondary" 
          rows="4" 
          placeholder="Explain your reasoning, address their concerns, or acknowledge their suggestion..."
        ></textarea>
        <small class="text-white-50 mt-1 d-block">
          Your response will affect your relationship with ${npc.name}
        </small>
      </div>

      <div class="d-grid gap-2">
        <button id="submit-clarification-btn" class="btn btn-${toneColor} btn-lg">
          <i class="bi bi-send me-2"></i>
          Respond to ${npc.name}
        </button>
        <button id="skip-clarification-btn" class="btn btn-outline-secondary">
          Skip (May damage relationship)
        </button>
      </div>
    `;

    $('#submit-clarification-btn').onclick = () => {
      const response = $('#clarification-response').value.trim();
      if (!response) {
        showAlert('warning', 'Please provide a response');
        return;
      }
      this.sounds.playClick();
      this.processClarificationResponse(npc, npcQuestion, response);
    };

    $('#skip-clarification-btn').onclick = () => {
      this.sounds.playClick();
      // Damage relationship for skipping
      this.npcRelationships[npc.id] = Math.max(0, this.npcRelationships[npc.id] - 5);
      this.npcEmotionalStates[npc.id] = 'frustrated';
      showAlert('warning', `${npc.name} seems disappointed you didn't respond (-5 relationship)`);
      this.advanceDay();
    };
  }

  async processClarificationResponse(npc, npcQuestion, playerResponse) {
    const scenarioContainer = $('#scenario-container');
    
    scenarioContainer.innerHTML = `
      <div class="text-center p-5">
        <div class="spinner-border text-info mb-3" style="width: 3rem; height: 3rem;"></div>
        <h5>${npc.name} is considering your response...</h5>
      </div>
    `;

    const prompt = `You are ${npc.name}, a ${npc.role}.
Your personality: ${npc.personality}
Your relationship with the manager: ${this.npcRelationships[npc.id]}/100

You asked: "${npcQuestion.question}"
Your concern was: "${npcQuestion.concern}"

The manager responded: "${playerResponse}"

Evaluate their response:
1. Does it address your concern adequately?
2. Do you feel heard and respected?
3. How does this affect your relationship?

Output ONLY valid JSON:
{
  "satisfied": true/false,
  "reaction": "Your emotional reaction to their response (1-2 sentences)",
  "relationshipChange": -10 to +15 (number),
  "newEmotionalState": "happy|neutral|concerned|frustrated"
}`;

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

      const evaluation = parseRelaxedJSON(fullText);
      
      // Update relationship and emotional state
      const oldRelationship = this.npcRelationships[npc.id];
      this.npcRelationships[npc.id] = Math.max(0, Math.min(100, oldRelationship + evaluation.relationshipChange));
      this.npcEmotionalStates[npc.id] = evaluation.newEmotionalState;

      // Show result
      const satisfiedColor = evaluation.satisfied ? 'success' : 'warning';
      const relationshipChangeText = evaluation.relationshipChange > 0 ? 
        `<span class="text-success">+${evaluation.relationshipChange}</span>` : 
        `<span class="text-danger">${evaluation.relationshipChange}</span>`;

      scenarioContainer.innerHTML = `
        <div class="text-center mb-4">
          <div class="fs-1 mb-3">${npc.avatar}</div>
          <h4 class="text-${satisfiedColor}">${npc.name}'s Response</h4>
        </div>

        <div class="alert alert-${satisfiedColor} mb-4">
          <p class="mb-0">"${evaluation.reaction}"</p>
        </div>

        <div class="alert alert-dark mb-4">
          <div class="row text-center">
            <div class="col-6">
              <h6>Relationship Change</h6>
              <div class="fs-4">${relationshipChangeText}</div>
              <small class="text-white-50">${oldRelationship} → ${this.npcRelationships[npc.id]}</small>
            </div>
            <div class="col-6">
              <h6>Emotional State</h6>
              <div class="fs-4">
                <span class="badge bg-secondary">${evaluation.newEmotionalState}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="d-grid">
          <button id="continue-btn" class="btn btn-primary btn-lg">
            Continue <i class="bi bi-arrow-right ms-2"></i>
          </button>
        </div>
      `;

      $('#continue-btn').onclick = () => {
        this.sounds.playClick();
        this.advanceDay();
      };

    } catch (e) {
      console.error("Clarification evaluation failed:", e);
      showAlert('danger', 'Failed to process response');
      this.advanceDay();
    }
  }


  async generateDynamicNPCs(industry, scenarioContext = "") {
    const prompt = `Generate 5 unique INTERNAL STAFF NPCs for a "${industry.name}" business.
    Context: ${industry.description || "A busy workplace"}. ${scenarioContext}
    
    CRITICAL RULES:
    1. EXCLUDE external roles like "Client", "Rival", "Competitor", "Customer", or "Supplier".
    2. ALL NPCs must be employees or internal stakeholders (e.g., Chef, Sous Chef, Shift Lead, Manager, Janitor, Accountant, Technician).
    3. Roles should be specific to the "${industry.name}" industry.
    4. Create diverse personalities (e.g., "Perfectionist", "Lazy but Talented", "Stressed Workaholic", "Cheerful Helper").

    Output ONLY a valid JSON array.
    Format: [{"id":"n1","name":"Name","role":"Role","personality":"Trait","avatar":"👤"}]`;
    
    try {
      const responseStream = await this.askLLM([{ role: 'user', content: prompt }]);
      let fullText = "";
      for await (const chunk of responseStream) {
        // Snapshot detection: if chunk starts with fullText, it's a resend
        if (chunk.startsWith(fullText) && fullText.length > 0) {
          fullText = chunk;
        } else {
          fullText += chunk;
        }
      }
      
      console.log("NPC Generation Response Length:", fullText.length);
      
      if (!fullText || !fullText.trim()) {
        console.warn("Empty NPC generation response, using fallback NPCs");
        return industry.npcs;
      }
      
      const data = parseRelaxedJSON(fullText);
      
      if (!data) {
        console.warn("parseRelaxedJSON returned null, using fallback NPCs");
        return industry.npcs;
      }
      
      if (Array.isArray(data) && data.length > 0) {
        console.log(`Successfully generated ${data.length} NPCs`);
        return data;
      } else {
        console.warn("Invalid NPC data structure, using fallback NPCs");
        return industry.npcs;
      }
    } catch(e) {
      console.warn("NPC Generation Error:", e.message);
      console.warn("Using fallback NPCs from industry config");
      return industry.npcs;
    }
  }

  async triggerRandomNPCInteraction() {
   if (Math.random() > 0.4) return; // 40% chance
   const npc = this.npcs[Math.floor(Math.random() * this.npcs.length)];
   
   if (!this.npcMemories) this.npcMemories = {};
   if (!this.npcMemories[npc.id]) this.npcMemories[npc.id] = [];
   
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
  // Retrieve Memory
  if (!this.npcMemories) this.npcMemories = {};
  if (!this.npcMemories[npc.id]) this.npcMemories[npc.id] = [];
  const memory = this.npcMemories[npc.id];

  // Construct System Prompt with Context Awareness
  const currentStoryCtx = this.storyline && this.storyline.length ? this.storyline[this.storyline.length - 1].summary : "Daily Operations";
  
  const systemPrompt = `Conversational Roleplay.
Character: ${npc.name} (${npc.role}). Personality: ${npc.personality}.
User Role: ${this.selectedRole.name}.
Current Environment: ${this.selectedIndustry.name}, Day ${this.currentDay}.
Story Context: ${currentStoryCtx}.
Current KPIs: ${Object.entries(this.kpis).map(([k,v]) => `${k}:${v}`).join(', ')}.

Context Memory: You have spoken with the user before. Use the conversation history provided.
GOAL: Act independently. You have your own feelings. If KPIs are low, you might be worried. If high, happy.
If the user asks about something relevant to the Current Situation or Story, respond appropriately.
If the user asks about another NPC (e.g. Jack), you can gossip or comment if you know them (assume you know your team).

Task: valid JSON response only.
1. "reply": Your response to the user. Keep it natural, concise (max 2 sentences).
 - If User said "SYSTEM_PROACTIVE": You are INTERRUPTING with an URGENT issue/doubt based on the Story Context or KPIs.
 - If User said "SYSTEM_GREETING": Greet the user casually.
 - Otherwise: Respond to the user's message/question.
2. "kpi_impact": Any key-value changes to KPIs based on this turn (e.g., {"staffMorale": 1} if user was nice, {"reputation": -1} if user was rude). Empty {} if neutral.
3. "thought_process": Internal thought explaining WHY you said this (for debugging/immersion).

Input: "${userMessage}"

Format: {"reply": "...", "kpi_impact": {}, "thought_process": "..."}

IMPORTANT SENTIMENT SCORING:
- If the User is RUDE, DISMISSIVE, or HOSTILE, you MUST reduce stats.
- RUDE/HOSTILE: {"staffMorale": -3} (or more severe).
- DISMISSIVE: {"staffMorale": -1}.
- POLITE/SUPPORTIVE: {"staffMorale": 1} (optional boost).
- ALWAYS evaluate the tone. Do not ignore rudeness.`;

  try {
    // Build Message Chain: System -> [History] -> User Input
    // We limit history to last 10 messages to save tokens/complexity if needed
    const recentHistory = memory.slice(-10);
    const messages = [
       { role: 'system', content: systemPrompt },
       ...recentHistory,
       { role: 'user', content: userMessage }
    ];

    const responseStream = await this.askLLM(messages);
    let fullText = "";
    for await (const chunk of responseStream) {
       if (chunk.startsWith(fullText) && fullText.length > 0) fullText = chunk; 
       else fullText += chunk;
    }
    
    let data;
    try {
      data = parseRelaxedJSON(fullText);
    } catch (e) {
      data = { reply: fullText.replace(/[*{}\"]/g, '').substring(0, 100), kpi_impact: {} };
    }

    appendMsg('npc', data.reply || "...");
    
    // Update Memory
    this.npcMemories[npc.id].push({ role: 'user', content: userMessage });
    this.npcMemories[npc.id].push({ role: 'assistant', content: data.reply });

    // Apply KPIs silently
    if (data.kpi_impact && Object.keys(data.kpi_impact).length > 0) {
      Object.entries(data.kpi_impact).forEach(([k, v]) => {
         if(this.kpis[k] !== undefined) this.kpis[k] += v;
      });
      this.updateKPIsDisplay();
      
      const toast = document.createElement('div');
      toast.className = 'small text-success ms-2';
      toast.innerText = 'KPIs Updated';
      if (modalEl && modalEl.querySelector) {
          const header = modalEl.querySelector('.modal-header');
          if(header) header.appendChild(toast);
      }
      setTimeout(() => toast.remove(), 2000);
    }

  } catch (e) {
    console.error(e);
    appendMsg('npc', "(Connection error)");
  }
}
}
