// Teva & Briut — WhatsApp Bot (full flow, with async handling + dedup to avoid loops)
// Node 22+ (כולל fetch מובנה). שימוש ב-Express + מצבי שיחה בזיכרון.

require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.json());

// ====== ENV ======
const API   = 'https://graph.facebook.com/v19.0/';
const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE = process.env.PHONE_NUMBER_ID;
const VERIFY= process.env.VERIFY_TOKEN || 'teva_verify_me';
const PORT  = process.env.PORT || 3000;
const LEAD_TOKEN = process.env.TEVA_LEAD_TOKEN || '';

// ====== HELPERS ======
const HDRS = () => ({
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json'
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// שליחת טקסט (preview_url=true כדי שקישורים יהיו לחיצים עם תצוגה מקדימה)
async function sendText(to, body, preview = true) {
  await fetch(`${API}${PHONE}/messages`, {
    method: 'POST',
    headers: HDRS(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body, preview_url: preview }
    })
  });
}

// שליחת כפתורי Reply (עד 3)
async function sendButtons(to, text, buttons) {
  await fetch(`${API}${PHONE}/messages`, {
    method: 'POST',
    headers: HDRS(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title }
          }))
        }
      }
    })
  });
}

// (אופציונלי) רשימת בחירה – לא חובה כרגע
async function sendList(to, header, text, rows) {
  await fetch(`${API}${PHONE}/messages`, {
    method: 'POST',
    headers: HDRS(),
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: header },
        body: { text },
        action: {
          button: 'בחר/י',
          sections: [{ rows: rows.map(r => ({ id: r.id, title: r.title })) }]
        }
      }
    })
  });
}

// ====== STATE (לפי משתמש) ======
const state = new Map(); // state.set(msisdn, { step, scratch:{} })

function setStep(user, step, extra = {}) {
  const cur = state.get(user) || {};
  state.set(user, { ...cur, step, ...extra });
}
function getStep(user) {
  return (state.get(user) || {}).step || null;
}
function setScratch(user, patch) {
  const cur = state.get(user) || {};
  cur.scratch = { ...(cur.scratch || {}), ...patch };
  state.set(user, cur);
}
function getScratch(user) {
  return (state.get(user) || {}).scratch || {};
}

// ====== MENUS & MESSAGES ======
async function menuMain(to) {
  await sendText(to, `היי וברוך/ה הבא/ה ל־טבע ובריאות ✨🌿\nאיך נוכל לעזור היום?`);
  await sendButtons(to, '👇 בחר/י מהאפשרויות', [
    { id: 'ORDER', title: 'מצב ההזמנה שלי' },
    { id: 'HOURS', title: 'שעות פתיחה וכתובת' },
    { id: 'MORE',  title: 'שאלות נוספות' }
  ]);
  setStep(to, 'MAIN');
}

async function menuMore(to) {
  await sendButtons(to, '👇 בחר/י אחת מהאפשרויות', [
    { id: 'SHIPPING',    title: 'אפשרויות משלוח' },
    { id: 'NO_TRACKING', title: 'לא קיבלתי מספר מעקב' },
    { id: 'CONSULT',     title: 'קביעת ייעוץ טלפוני' }
  ]);
  setStep(to, 'MORE');
}

async function askBackToMain(to) {
  await sendButtons(to, '🙂 האם תרצה לחזור לתפריט הראשי?', [
    { id: 'BACK_MAIN_YES', title: 'כן' },
    { id: 'BACK_MAIN_NO',  title: 'לא' }
  ]);
  setStep(to, 'ASK_BACK');
}

async function msgThanks(to) {
  await sendText(to, `🌸 תודה רבה לך!\nמקווים שעזרנו והכול היה ברור ונעים.\nאנחנו כאן תמיד בשבילך לכל שאלה או צורך 💚\nמאחלים המשך יום מקסים ובריאות שלמה,\nצוות טבע ובריאות 🌿`);
  state.delete(to);
}

// ====== FLOWS ======
async function flowOrder(to) {
  await sendButtons(to, 'האם יש בידיך את מספר המעקב שלך? 📦', [
    { id: 'HAS_TRACK_YES', title: 'כן' },
    { id: 'HAS_TRACK_NO',  title: 'לא' }
  ]);
  setStep(to, 'ASK_HAVE_TRACK');
}

async function flowAskTracking(to) {
  await sendText(to, 'אנא הזן/י כאן את מספר המעקב שלך (8–14 ספרות ומתחיל ב־1) כפי שקיבלת במייל 📩');
  setStep(to, 'WAIT_TRACKING');
}

async function flowAskOrderId(to) {
  await sendText(
    to,
    `האם יש בידיך את מספר ההזמנה? 📦 תוכל למצוא אותו בקלות במייל אישור ההזמנה שקיבלת מאתר טבע ובריאות.\n\nאנא הזן/י את מספר ההזמנה (5 ספרות ומתחיל ב־2).`
  );
  setStep(to, 'WAIT_ORDER');
}

async function flowHours(to) {
  await sendText(to,
`🕒 שעות פעילות:

א׳-ה׳ 09:00–19:30
שישי וערבי חג 09:00–14:00

📍 כתובות הסניפים:

• הקליטה 3, כיכר הסיטי, אשדוד
• חיים משה שפירא 22, אשדוד

נשמח לראותך! 🌿`);
  await askBackToMain(to);
}

async function flowShipping(to) {
  await sendText(to,
`📦 אפשרויות משלוח – טבע ובריאות
(העלויות וזמני המשלוח משוערים ועשויים להשתנות. ⚠️ שירות "נקודת חלוקה" אינו פעיל זמנית.)

1️⃣ איסוף עצמי — חינם
📍 חיים משה שפירא 22, אשדוד
📩 תישלח הודעה כשההזמנה מוכנה לאיסוף

2️⃣ שליח עד הבית — ₪29.90
⏱ 2–4 ימי עסקים | עד ~6 ק״ג
🎁 משלוח חינם מעל ₪400

3️⃣ נקודת חלוקה — ₪15 (לא פעיל זמנית)
⛔ כרגע לא ניתן לבחור בנקודת חלוקה. נעדכן כשיחזור לפעילות.
⏱ 4–8 ימי עסקים
📩 נשלחת הודעת SMS כשהחבילה זמינה לאיסוף

ℹ️ ייתכנו עיכובים בזמני המשלוח בהתאם לחברת השליחויות.
☎️ מוקד YDM: 03-507-2020
🔎 מספר מעקב יישלח במייל אישור ההזמנה.`);
  await askBackToMain(to);
}

async function flowNoTracking(to) {
  await sendText(to,
`לצורך בדיקת מעקב המשלוח דרוש מספר ההזמנה 📦
אנא בדוק/י את מייל אישור ההזמנה מהאתר והזן/י אותו כאן מחדש.`);
  await flowAskOrderId(to);
}

async function flowConsultStart(to) {
  await sendText(to, 'אנחנו כאן כדי לעזור וללוות אותך באופן אישי 🌿\nכדי שנוכל לחזור אליך בהקדם, נצטרך כמה פרטים בסיסיים 🙏');
  await sendText(to, 'נתחיל בשם שלך 🙂 איך לפנות אליך? (שם מלא)');
  setStep(to, 'WAIT_NAME');
  setScratch(to, { name: '', phone: '', topic: '' });
}

// ====== API CALLS ======
async function lookupTrackingByOrder(orderId) {
  try {
    const resp = await fetch('https://teva-briut.co.il/wp-json/teva/v1/lookup-tracking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_id: orderId })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      first_name: data.billing_first_name || '',
      tracking_number: data.tracking_number || '',
      tracking_url:
        data.tracking_url ||
        (data.tracking_number ? `https://status.ydm.co.il/?shipment_id=${data.tracking_number}` : '')
    };
  } catch {
    return null;
  }
}

async function submitLead(name, phone, topic) {
  try {
    const url = 'https://teva-briut.co.il/wp-json/teva/v1/lead';
    const body = { name, phone, topic, token: LEAD_TOKEN };
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// ====== DEDUP (מניעת לולאות עקב Retries) ======
const processed = new Map(); // msg.id -> timestamp
function seen(id) {
  if (!id) return false;
  if (processed.has(id)) return true;
  processed.set(id, Date.now());
  // ניקוי אחרי 5 דקות
  setTimeout(() => processed.delete(id), 5 * 60 * 1000).unref?.();
  return false;
}

// ====== WEBHOOK VERIFY ======
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// ====== WEBHOOK RECEIVE ======
// מחזירים 200 מייד ומעבדים ברקע (כדי למנוע Retries ממשושכים)
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  handleWebhook(req.body).catch(err => console.error('handleWebhook error:', err));
});

async function handleWebhook(body) {
  const entry = body?.entry?.[0];
  const value = entry?.changes?.[0]?.value;

  // מתעניינים רק בהודעות נכנסות (messages), לא ב-statuses
  const msg = value?.messages?.[0];
  if (!msg) return;

  // דה-דופליקציה
  if (seen(msg.id)) return;

  const from = msg.from;
  const step = getStep(from);

  // 1) כפתורים אינטראקטיביים
  if (msg.type === 'interactive') {
    const id = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id;
    switch (id) {
      case 'ORDER'        : return flowOrder(from);
      case 'HOURS'        : return flowHours(from);
      case 'MORE'         : return menuMore(from);

      case 'SHIPPING'     : return flowShipping(from);
      case 'NO_TRACKING'  : return flowNoTracking(from);
      case 'CONSULT'      : return flowConsultStart(from);

      case 'HAS_TRACK_YES': return flowAskTracking(from);
      case 'HAS_TRACK_NO' : return flowAskOrderId(from);

      case 'BACK_MAIN_YES': return menuMain(from);
      case 'BACK_MAIN_NO' : return msgThanks(from);

      default: return menuMain(from);
    }
  }

  // 2) טקסט חופשי לפי שלב
  const text = (msg.text?.body || '').trim();

  switch (step) {
    case 'WAIT_TRACKING': {
      const ok = /^1\d{7,13}$/.test(text); // 8–14 ספרות ומתחיל ב-1
      if (!ok) {
        await sendText(from, 'המספר לא תקין. אנא הזנ/י מספר מעקב 8–14 ספרות שמתחיל ב־1.');
        return;
      }
      await sendText(
        from,
        `תודה! קיבלנו את מספר המעקב שלך: ${text} 📦
לחץ/י כאן למעקב מלא:
https://status.ydm.co.il/?shipment_id=${text}`,
        true
      );
      await askBackToMain(from);
      return;
    }

    case 'WAIT_ORDER': {
      const ok = /^2\d{4}$/.test(text); // 5 ספרות ומתחיל ב-2
      if (!ok) {
        await sendText(from, 'אופס, מספר ההזמנה לא תקין. נא להזין 5 ספרות שמתחיל ב־2.');
        return;
      }
      await sendText(from, 'בודקים עבורך… 🔎'); await sleep(600);
      const info = await lookupTrackingByOrder(text);
      if (info && (info.tracking_url || info.tracking_number)) {
        const tn = info.tracking_number ? `${info.tracking_number}` : '';
        const url = info.tracking_url || (info.tracking_number ? `https://status.ydm.co.il/?shipment_id=${info.tracking_number}` : '');
        await sendText(
          from,
          `${info.first_name ? '🌸 ' + info.first_name + '\n' : ''}רציתי לעדכן שמספר המעקב של ההזמנה שלך הוא: ${tn} 📦
תוכל/י לעקוב אחר המשלוח בכל שלב בלינק הזה:
${url}

תודה שבחרת בטבע ובריאות 💚 מאחלים לך המשך יום נעים!`,
          true
        );
      } else {
        await sendText(from, 'לא הצלחתי למצוא מעקב להזמנה הזו. אפשר לנסות שוב או לפנות אלינו.');
      }
      await askBackToMain(from);
      return;
    }

    case 'WAIT_NAME': {
      setScratch(from, { name: text });
      await sendText(from, `מעולה, ${text} 🙂\nמה מספר הטלפון שבו נח לחזור אליך? (05XXXXXXXX)`);
      setStep(from, 'WAIT_PHONE');
      return;
    }

    case 'WAIT_PHONE': {
      if (!/^05\d{8}$/.test(text)) {
        await sendText(from, 'נראה שיש טעות במספר 📱\nנא להזין מספר נייד תקין: 05XXXXXXXX (10 ספרות).');
        return;
      }
      setScratch(from, { phone: text });
      await sendText(from, 'ולבסוף – כדי שנוכל להכין את השיחה בצורה הטובה ביותר, במה תרצה שנתמקד בייעוץ?');
      setStep(from, 'WAIT_TOPIC');
      return;
    }

    case 'WAIT_TOPIC': {
      const s = getScratch(from);
      s.topic = text;
      await sendText(from, 'רושמים ומעבירים… ✍️'); await sleep(600);
      const ok = await submitLead(s.name, s.phone, s.topic);
      await sendText(
        from,
        `💚 ${s.name}
אנחנו מעריכים את זה ששיתפת אותנו 🙏
קיבלנו את הפנייה שלך ונדאג שתקבל/י מענה רגיש ואכפתי בהקדם.
נלווה אותך בכל צעד בדרך לבריאות 🌸`
      );
      if (!ok) await sendText(from, 'הערה: לא הצלחנו לאשר את קליטת הפנייה במערכת, נטפל בזה ידנית אם יידרש.');
      await askBackToMain(from);
      return;
    }

    case 'ASK_BACK': {
      // אם המשתמש מקליד במקום ללחוץ — נחזיר תפריט
      return await menuMain(from);
    }

    default: {
      // כל הודעה ראשונה/לא מזוהה — תפריט ראשי
      return await menuMain(from);
    }
  }
}

// ====== START ======
app.listen(PORT, () => console.log(`Bot running on http://localhost:${PORT}`));
