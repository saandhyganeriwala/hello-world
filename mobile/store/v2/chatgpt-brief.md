# Brief for ChatGPT: App Store screenshots for CRUD.chat

Paste everything below the line into ChatGPT. Attach these files with it:
- The 13 real interface captures in `mobile/store/v2/ui-captures/`
- The finished set in `mobile/store/v2/iphone/` as a reference for the layout and story

---

You are a senior App Store creative designer. Make a set of 6 App Store screenshots for my iPhone and iPad app, **CRUD.chat**. Many people decide whether to install from the first two screenshots, so each one has to explain a benefit in about one second.

## What the product is

CRUD.chat replaces spreadsheets for small teams such as shops, traders, caterers, agencies and sales teams. People don't fill in forms or cells. They **send a message**, the way they'd tell a colleague:

- Typed: "Order from Kashish 45 Samayi at 500 each, deliver Hyderabad"
- A voice note in English or Hinglish: "Ravi bhai ne 12,000 UPI se bhej diya, baaki Friday tak"
- A screenshot of a customer's WhatsApp chat or a bill

AI turns each message into structured records (customer, quantity, amount, status, delivery) and files them into sections that it creates: Orders, Payments, Leads, Tasks, Inventory.

Then:
- **Ask anything:** "How much is pending from Hotel Orchid?" gets an exact answer from the team's own records.
- **The app reshapes itself:** say "show leads as a pipeline" or "add a chart of sales by month" and that view appears. It's like a piece of software that keeps updating itself around the business.
- **Teams:** everyone records from their own phone, and everyone sees changes live.

Audience: owners and staff of small Indian businesses (and similar teams worldwide). They are busy, often on the phone, and comfortable with WhatsApp but not with Excel.

Tone: confident, plain, warm, a little playful. No jargon such as "AI-powered", "leverage" or "seamless".

## Design language: "Haldi & Ink"

| Token | Value | Use |
|---|---|---|
| Marigold (haldi) | `#FFC31F` | Highlight, the user's message bubbles, the headline highlight bar, the arrow buttons |
| Ink | `#141414` | Text, thick outlines, hard offset shadows |
| Paper | `#F4F2EC` | Background, with a faint 56 px grid |
| Peacock | `#0E8A8A` | Small accents: the kicker label, avatars |
| Muted text | `#46433D` | Sublines |

- **Headline font:** Bricolage Grotesque ExtraBold (800), tight letter spacing (−3.5%). One key phrase sits on a marigold highlight bar.
- **Body font:** Hanken Grotesk 500–700.
- **Labels:** JetBrains Mono 600, uppercase, wide tracking, small (for example "YOU TYPE", "IT BECOMES AN ORDER").
- **Mascot and logo:** a friendly baby elephant inside a marigold rounded square with a thick ink outline. Use it small, next to the "CRUD.chat" wordmark at the top.
- **Feel:** warm paper, bold ink, Indian-market warmth without clichés. Flat with soft drop shadows, plus a few "sticker" elements with thick ink borders and hard offset shadows. No gradients on text, no glassmorphism, no neon.

## Hard rule (Apple Guideline 2.3)

The app interface shown must be **real**. Use the attached captures exactly as they are: you may scale, crop, rotate slightly, add a drop shadow or put them in a device frame. **Do not redraw, retype or invent any app interface, numbers or text inside them.** Everything around them (headline, background, arrows, labels, decoration) is yours to design.

## The 6 screenshots (story order)

Each screenshot shows a **before → after transformation**, not just a screen.

1. **Record by message.** Headline: "Stop typing into **spreadsheets.**" Subline: "Just send a message. CRUD.chat turns it into a record." Visual: `msg-kashish.png` (labelled YOU TYPE), an arrow, then `card-kashish.png` (labelled IT BECOMES AN ORDER).
2. **Voice.** Headline: "Say it. **It's recorded.**" Subline: "Talk in English or Hinglish. Orders, payments and tasks fill themselves in." Visual: a voice-recording pill with a red mic and waveform (you may draw this one; it's a recording indicator, not app UI), an arrow, then `msg-hinglish.png`.
3. **Screenshots.** Headline: "Snap a screenshot. **It's filed.**" Subline: "Customer chats and bills are read and turned into orders." Visual: `msg-screenshot.png`, an arrow, then `card-ananya.png`.
4. **Answers.** Headline: "Ask. **Get the answer.**" Subline: "No formulas. Every question is answered from your own records." Visual: `msg-question.png`, then `msg-answer.png`, then `card-orchid.png` (labelled FROM THIS ORDER).
5. **The app builds itself.** Headline: "The app **builds itself.**" Subline: "Pipelines, dashboards and ledgers appear as you go. Just ask for any view." Visual: `msg-pipeline-ask.png`, an arrow, then `view-pipeline.png`, `view-overview.png` and optionally `view-ledger.png`.
6. **Teams.** Headline: "One live record for **the whole team.**" Subline: "Everyone records from their phone. Everyone sees it instantly." Visual: `screen-orders.png` inside an iPhone frame that bleeds off the bottom edge, with `msg-hinglish.png` floating over it, slightly rotated.

You may propose stronger headlines, but keep each one to 7 words or fewer and keep the benefit concrete. Screenshot 1 must make the "no spreadsheets, just message it" idea obvious at thumbnail size.

## Layout rules

- Headline in the top 30%, centred, large (about 10% of canvas width per line), at most 2 lines.
- The real UI must be large and readable at thumbnail size, filling the lower 65% with no big empty areas.
- Keep 5% safe margins, and keep the same headline position on all 6 so the set reads as one strip.
- Leave out device status bars, App Store badges, prices, "#1" claims and testimonials.

## Sizes to deliver (PNG, sRGB, no transparency)

| Slot in App Store Connect | Size (portrait) |
|---|---|
| iPhone (Dynamic Island, medium display) | 1206 × 2622 |
| iPhone Duo | 2007 × 2853 |
| iPad 13" | 2064 × 2752 |

Start with screenshot 1 at 1206 × 2622 and show it to me before doing the rest.

## Optional: app preview video (886 × 1920, 15–30 s)

Storyboard: 0–3 s the screenshot 1 headline; 3–10 s a message is typed and sent, and the order card pops in; 10–16 s a voice note is turned into a Payments record; 16–22 s a question gets its answer; 22–28 s "show leads as a pipeline" and the board appears; end on the logo with "crud.chat". Apple requires previews to be **screen recordings of the real app** (with captions and transitions allowed), so use this storyboard as a shot list for recording on an iPhone, not for generating footage.
