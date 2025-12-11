# Strategy Game Simulator

An AI-powered, scenario-based Strategy Game game that helps managers and aspiring leaders practice real-world decision-making in a safe, interactive environment.

## 🎯 Overview

This is not just a simple quiz game - it's a comprehensive Strategy Game simulator that:

- **Presents realistic scenarios** based on actual industry challenges
- **Features interactive NPCs** with unique personalities and perspectives
- **Tracks multiple KPIs** that change based on your decisions
- **Uses AI** to generate dynamic, contextual scenarios and dialogues
- **Provides consequence-based learning** where every decision matters

## 🎮 How It Works

### 1. Setup Phase
The game asks you to configure your training session:

- **Choose Industry**: Fast Food, Retail, Hotel Management, etc.
- **Select Role**: Store Manager, Regional Manager, General Manager, etc.
- **Pick Difficulty**: Training Mode, Normal, Challenging, or Expert
  - Different difficulties affect scenario complexity, event frequency, and consequence severity

### 2. Gameplay

Each day presents you with:
- **Realistic Scenarios**: Situations that managers actually face
- **Multiple Options**: Each with different consequences
- **KPI Impacts**: Your decisions affect Budget, Sales, Customer Satisfaction, Staff Morale, Inventory, Reputation, and Efficiency
- **NPC Interactions**: Talk to your team members for insights and perspectives

### 3. Learning Outcomes

The game teaches:
- **Decision-making** under pressure
- **Resource management** (budget, inventory, staff)
- **Stakeholder management** (customers, employees, suppliers)
- **Crisis handling** and problem-solving
- **Strategic thinking** and consequence analysis

## 🏗️ Architecture

### Files Structure

```
s-game/
├── index.html              # Main HTML file
├── script.js               # Game logic and AI integration
├── game-config.json        # Industries, roles, NPCs, difficulties
├── boardgame.css          # Original board game styles
├── game-styles.css        # Enhanced UI styles
└── config.json            # Legacy config (not used)
```

### Key Components

1. **ManagementGame Class**: Main game controller
   - Handles game flow and state management
   - Manages setup screens and transitions
   - Coordinates AI scenario generation

2. **AI Integration**:
   - Uses OpenAI-compatible API for scenario generation
   - Generates contextual NPC dialogues
   - Creates realistic management challenges

3. **KPI System**:
   - 7 tracked metrics per game
   - Dynamic updates based on decisions
   - Visual feedback with progress bars

4. **NPC System**:
   - Each industry has unique team members
   - NPCs have personalities that affect their dialogue
   - Interactive conversations provide insights

## 🎨 Industries & Roles

### Fast Food Chain
**Roles**: Store Manager, Regional Manager
**NPCs**: Head Chef, Shift Supervisor, Cashier, Supplier, Regular Customer
**Focus**: High-volume operations, customer service, inventory management

### Retail Store
**Roles**: Store Manager
**NPCs**: Assistant Manager, Sales Associate, Stock Clerk
**Focus**: Sales, inventory, customer experience

### Hotel Management
**Roles**: General Manager
**NPCs**: Front Desk Manager, Housekeeping Supervisor, Executive Chef
**Focus**: Guest satisfaction, multi-department coordination, service quality

## 🔧 Configuration

### LLM Setup
1. Click "Configure" in the navbar
2. Enter your OpenAI-compatible API endpoint
3. Add your API key
4. Select your preferred model

### Supported LLM Providers
- OpenAI (GPT-4, GPT-4o-mini, etc.)
- Azure OpenAI
- Any OpenAI-compatible endpoint (LocalAI, Ollama with OpenAI compatibility, etc.)

## 📊 KPI Descriptions

| KPI | Description | Impact |
|-----|-------------|--------|
| **Budget** | Available operational funds | Affected by expenses and revenue |
| **Sales** | Revenue generated | Increases with good decisions |
| **Customer Satisfaction** | How happy customers are | Affects reputation and repeat business |
| **Staff Morale** | Employee happiness | Impacts efficiency and turnover |
| **Inventory** | Stock levels | Too high = waste, too low = lost sales |
| **Reputation** | Public perception | Long-term business success |
| **Efficiency** | Operational effectiveness | Affects all other metrics |

## 🎓 Difficulty Levels

### Training Mode
- 5 days
- Low event frequency
- 50% consequence severity
- Best for learning the basics

### Normal
- 7 days
- Medium event frequency
- 100% consequence severity
- Balanced realistic experience

### Challenging
- 10 days
- High event frequency
- 150% consequence severity
- For experienced managers

### Expert
- 14 days
- Very high event frequency
- 200% consequence severity
- Maximum challenge

## 🚀 Getting Started

1. **Open the game**: Load `index.html` in a modern browser
2. **Configure LLM**: Set up your AI provider (required for scenarios)
3. **Start Setup**: Click "Start Setup" on the welcome screen
4. **Choose your path**: Select industry, role, and difficulty
5. **Play**: Make decisions and learn from consequences

## 💡 Tips for Best Experience

1. **Read scenarios carefully** - Details matter
2. **Talk to NPCs** - They provide valuable perspectives
3. **Watch all KPIs** - Don't focus on just one metric
4. **Think long-term** - Some decisions have delayed consequences
5. **Learn from mistakes** - The game is designed for safe learning

## 🔐 Privacy & Data

- **Authentication**: Optional Google sign-in via Supabase
- **Session Storage**: Saves game progress (if authenticated)
- **LLM Config**: Stored locally in browser
- **No tracking**: No analytics or third-party tracking

## 🛠️ Technical Details

### Dependencies
- Bootstrap 5.3.8 (UI framework)
- Bootstrap Icons 1.13.1
- AsyncLLM (AI streaming)
- Supabase (optional authentication)
- Marked (markdown rendering)

### Browser Requirements
- Modern browser with ES6+ support
- JavaScript enabled
- LocalStorage enabled
- Internet connection (for LLM API calls)

## 📝 Customization

### Adding New Industries

Edit `game-config.json`:

```json
{
  "industries": [
    {
      "id": "your-industry",
      "name": "Your Industry Name",
      "icon": "bi-icon-name",
      "description": "Description",
      "roles": [...],
      "npcs": [...]
    }
  ]
}
```

### Adding New NPCs

```json
{
  "id": "npc-id",
  "name": "NPC Name",
  "role": "Job Title",
  "personality": "Personality description",
  "avatar": "👤"
}
```

### Modifying Difficulties

Adjust in `game-config.json`:
- `daysToComplete`: Game length
- `eventFrequency`: How often scenarios occur
- `consequenceSeverity`: Multiplier for KPI changes

## 🤝 Contributing

This is a training tool designed to be extended. Consider adding:
- New industries and roles
- More diverse NPCs
- Additional KPIs
- Custom scenario templates
- Multi-language support

## 📄 License

This project is open source and available for educational and training purposes.

## 🙏 Acknowledgments

Built with:
- AI-powered scenario generation
- Bootstrap for responsive UI
- Supabase for backend services
- Community feedback and testing

---

**Remember**: This is a training simulator. Real-world management requires experience, empathy, and continuous learning. Use this tool to practice, but always apply critical thinking in actual situations.
