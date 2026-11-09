// @ts-nocheck — verbatim port of the prototype's tested on-device parser.
// Used ONLY when Claude is unavailable (no API key, or an outage), so that
// recording still works. It understands common orders / payments / inquiries /
// meetings / tasks and simple status updates; it cannot answer questions or
// run interface commands.
import { recTitle as recTitleFor } from "./helpers.js";

type Rec = { id: string; section: string; fields: Record<string, string> };
let CURRENT_RECORDS: Rec[] = [];
const recTitle = (r: Rec) => recTitleFor(r.section, r.fields);

function inr(n){ try{return Math.round(n).toLocaleString('en-IN');}catch(e){return String(n);} }
function cap1(s){ s=String(s||'').trim(); return s?s[0].toUpperCase()+s.slice(1):s; }
function escRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function cleanName(s){ return String(s).replace(/[^\w.&'’ -]/g,'').replace(/\s+/g,' ').replace(/^[\s.\-]+|[\s.\-]+$/g,'').trim(); }
function firstWords(t,n){ const a=t.trim().split(/\s+/); return a.slice(0,n).join(' ')+(a.length>n?'…':''); }

function extractPerson(t){
  let m;
  m=t.match(/\b(?:order|inquiry|enquiry|payment|call|message|lead|request|note|booking|complaint)\s+(?:is\s+)?from\s+([A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*)?)/);
  if(m) return cleanName(m[1]);
  m=t.match(/\bfrom\s+([A-Z][a-z][\w.'’-]*(?:\s+[A-Z][a-z][\w.'’-]*)?)/);
  if(m && !/^(Hyderabad|Delhi|Mumbai|Bangalore|Bengaluru|Chennai|Kolkata|Pune|Today|Tomorrow)$/i.test(m[1])) return cleanName(m[1]);
  m=t.match(/^([A-Z][a-z][\w.'’-]*)(?:'s|’s)?\s+(?:wants?|needs?|asked|asking|called|is|has|had|ordered|requested|enquired|inquired|would|placed|paid)/);
  if(m) return cleanName(m[1]);
  m=t.match(/\b(?:ordered|placed|requested|paid|received)\s+by\s+([A-Z][a-z][\w.'’-]*(?:\s+[A-Z][a-z][\w.'’-]*)?)/);
  if(m) return cleanName(m[1]);
  m=t.match(/\b(?:meeting|call|appointment|demo|visit)\s+with\s+([A-Z][a-z][\w.'’-]*(?:\s+[A-Z][a-z][\w.'’-]*)?)/);
  if(m) return cleanName(m[1]);
  m=t.match(/\bwith\s+([A-Z][a-z][\w.'’-]*(?:\s+[A-Z][a-z][\w.'’-]*)?)/);
  if(m) return cleanName(m[1]);
  m=t.match(/\bfor\s+([A-Z][a-z][\w.'’-]*)\b/);
  if(m && !/^(Product|Order|Delivery|Payment|Inquiry)$/i.test(m[1])) return cleanName(m[1]);
  return '';
}
function qtyNum(low){ const m=low.match(/(\d+(?:\.\d+)?)\s*(pieces?|pcs?|boxes?|units?|nos?|pairs?|kgs?|packets?|pkts?|cartons?|dozens?|sets?|bottles?|bags?|plates?|kilos?)\b/); return m?parseFloat(m[1]):null; }
function extractQty(low){
  const m=low.match(/(\d+(?:\.\d+)?)\s*(pieces?|pcs?|boxes?|units?|nos?\.?|pairs?|kgs?|grams?|gms?|packets?|pkts?|cartons?|dozens?|sets?|bottles?|bags?|plates?|kilos?)\b/);
  if(!m) return ''; return m[1]+' '+m[2].replace(/\.$/,'');
}
function extractRate(t){
  const m=t.match(/(?:at|@|for)\s*(₹|rs\.?|inr|\$)?\s*([\d,]+(?:\.\d+)?)\s*(?:\/-?\s*)?(?:per|each|a|\/)\s*(piece|pc|box|unit|kg|pair|gram|packet|carton|set|dozen|plate)?/i);
  if(!m) return {text:'',num:null};
  const num=parseFloat(m[2].replace(/,/g,''));
  const per=m[3]?('/'+m[3].toLowerCase()):' each';
  return {text:'₹'+inr(num)+per, num};
}
function extractAmount(t){
  let m=t.match(/(?:total|amount|worth|sum|bill|payment of|paid|advance of|deposit of)\s*(?:of|:|is|=)?\s*(?:₹|rs\.?|inr|\$)?\s*([\d,]+(?:\.\d+)?)/i);
  if(m) return {text:'₹'+inr(parseFloat(m[1].replace(/,/g,''))), num:parseFloat(m[1].replace(/,/g,''))};
  m=t.match(/(?:₹|rs\.?|inr|\$)\s*([\d,]+(?:\.\d+)?)/i);
  if(m) return {text:'₹'+inr(parseFloat(m[1].replace(/,/g,''))), num:parseFloat(m[1].replace(/,/g,''))};
  return {text:'',num:null};
}
function extractLocation(t){
  let m=t.match(/\b(?:deliver(?:y)?|dispatch|ship(?:ping)?|send|courier|drop)\s+(?:it\s+)?(?:to\s+)?([A-Z][a-z][\w.'’-]*(?:\s+[A-Z][a-z][\w.'’-]*)?)/);
  if(m) return cleanName(m[1]);
  m=t.match(/\bto\s+([A-Z][a-z][\w.'’-]*)\s*[.!]?\s*$/);
  if(m) return cleanName(m[1]);
  return '';
}
function extractProduct(t){
  let m=t.match(/(?:pieces?|pcs?|boxes?|units?|packets?|cartons?|kgs?|sets?|pairs?|bottles?|bags?|plates?)\s+of\s+([A-Za-z][\w &'’-]*?)(?=\s+(?:at|for|@|deliver|to)\b|[,.\-–]|$)/i);
  if(m) return cap1(m[1].trim());
  m=t.match(/\bfor\s+(?:the\s+)?(product\s+[A-Za-z0-9][\w &'’-]*?|[A-Za-z][\w &'’-]*?)(?=\s+\d|\s+at\b|[,.\-–]|$)/i);
  if(m) return cap1(m[1].replace(/^the\s+/i,'').trim());
  return '';
}
function extractWhen(low){
  const m=low.match(/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s+(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?/i)
      || low.match(/\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i)
      || low.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  return m?cap1(m[0].replace(/^at\s+/i,'').trim()):'';
}
function extractInterest(t,person){
  let s=t;
  if(person) s=s.replace(new RegExp('^\\s*'+escRe(person)+"(?:'s|’s)?\\s*",'i'),'');
  s=s.replace(/^(?:wants? to know(?: about)?|wants? to|wants?|would like|is interested in|interested in|asked (?:for|about)|asking (?:for|about)|needs?|looking for|enquired about|inquired about|is asking(?: about)?)\s+/i,'');
  s=s.replace(/^(?:our|the|about|for|us)\s+/i,'');
  const parts=s.split(/\s+and\s+|\s*&\s*|;\s*/i).map(x=>x.trim().replace(/^(?:a|an|also|to)\s+/i,'').replace(/[.,]\s*$/,'')).filter(Boolean);
  let interest='', request='';
  parts.forEach(p=>{
    if(/\b(call|video call|meet|meeting|demo|visit|sample|catalog|catalogue|schedule|appointment)\b/i.test(p)) request=request?request+'; '+cap1(p):cap1(p);
    else interest=interest?interest+'; '+cap1(p):cap1(p);
  });
  if(!interest && !request) interest=cap1(s.replace(/[.,]\s*$/,''));
  return {interest,request};
}
function classify(low){
  const money=/(₹|rs\.?|inr|\$)\s*[\d,]/i.test(low) || /\b\d[\d,]*\s*(rupees?|bucks)\b/.test(low);
  if(/\b(payment|paid|advance|deposit|balance paid|part payment|upi|neft|rtgs|cash received|received cash)\b/.test(low) || (/\breceived\b/.test(low)&&money&&!/\border\b/.test(low)))
    return {section:'Payments',icon:'rupee',status:'Received'};
  if(/\b(order|ordered|reorder|purchase|purchased|buy|buying|quantity|qty)\b/.test(low) || qtyNum(low)!=null)
    return {section:'Orders',icon:'package',status:'New'};
  if(/\b(meeting|appointment|video call|zoom|google meet|call at|demo on|visit on|come over|scheduled)\b/.test(low) && /\b(am|pm|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?)\b/.test(low))
    return {section:'Meetings',icon:'calendar',status:'Scheduled'};
  if(/\b(wants?|interested|enquir|inquir|asking|rate|rates|quote|quotation|wholesale|price list|pricing|catalog|catalogue|sample|demo|would like|looking for)\b/.test(low))
    return {section:'Inquiries',icon:'chat',status:'New'};
  if(/\b(follow ?up|call back|callback|remind|reminder|to-?do|task|chase|pending with)\b/.test(low))
    return {section:'Tasks',icon:'task',status:'Pending'};
  return {section:'Notes',icon:'note',status:''};
}
function buildFields(t,low,cat){
  const f={}; const person=extractPerson(t);
  if(cat.section==='Orders'){
    const prod=extractProduct(t), qty=extractQty(low), rate=extractRate(t), loc=extractLocation(t);
    let amt=extractAmount(t); const qn=qtyNum(low);
    if(rate.num!=null && qn!=null){ const c=Math.round(rate.num*qn);
      if(!/\b(total|amount|worth|bill)\b/.test(low) || !amt.num) amt={text:'₹'+inr(c),num:c}; }
    if(person) f.Customer=person;
    if(prod) f.Product=prod;
    if(qty) f.Quantity=qty;
    if(rate.text) f.Rate=rate.text;
    if(amt.text) f.Amount=amt.text;
    if(loc) f.Delivery=loc;
    f.Title=person||prod||'New order'; f.Status=cat.status;
  } else if(cat.section==='Payments'){
    const amt=extractAmount(t);
    if(person) f.Customer=person;
    if(amt.text) f.Amount=amt.text;
    const mode=low.match(/\b(cash|upi|neft|rtgs|bank transfer|cheque|check|card|gpay|google pay|phonepe|paytm)\b/);
    if(mode) f.Mode=cap1(mode[1]);
    f.Title=person||'Payment'; f.Status=cat.status;
  } else if(cat.section==='Inquiries'){
    if(person) f.Customer=person;
    const i=extractInterest(t,person);
    if(i.interest) f.Interest=i.interest;
    if(i.request) f.Request=i.request;
    f.Title=person||'Inquiry'; f.Status=cat.status;
  } else if(cat.section==='Meetings'){
    if(person) f.With=person;
    const when=extractWhen(low); if(when) f.When=when;
    const loc=extractLocation(t); if(loc) f.Where=loc;
    f.Title=person?('Meeting with '+person):'Meeting'; f.Status=cat.status;
  } else if(cat.section==='Tasks'){
    if(person) f.For=person;
    f.Title=firstWords(t,8); f.Status=cat.status;
  } else {
    f.Title=firstWords(t,8); if(t.trim().length>48) f.Detail=t.trim();
  }
  return f;
}
function statusFromVerb(low){
  if(/\bout for delivery\b/.test(low)) return 'Out for delivery';
  if(/\bdispatch(?:ed|ing)?\b/.test(low)) return 'Dispatched';
  if(/\bshipp?ed\b/.test(low)) return 'Shipped';
  if(/\bdeliver(?:ed)?\b/.test(low)) return 'Delivered';
  if(/\bcancel(?:led|ed)?\b/.test(low)) return 'Cancelled';
  if(/\bconfirm(?:ed)?\b/.test(low)) return 'Confirmed';
  if(/\b(complete[d]?|done|closed|finished)\b/.test(low)) return 'Done';
  if(/\bpayment (?:received|done|cleared)\b/.test(low)||/\bfully paid\b/.test(low)||/\bmark(?:ed)? paid\b/.test(low)) return 'Paid';
  if(/\bready\b/.test(low)) return 'Ready';
  if(/\breschedul/.test(low)) return 'Rescheduled';
  if(/\bpack(?:ed|ing)?\b/.test(low)) return 'Packing';
  return '';
}
function parseChanges(t,low){
  const ch={}; let m;
  const re=/\b(?:change|set|update|make)\s+(?:the\s+)?([a-z][a-z ]{1,18}?)\s+(?:to|as|=)\s+([^,;.]+)/gi;
  while((m=re.exec(t))){ const k=cap1(m[1].trim()); if(k.length>1) ch[k]=m[2].trim(); }
  m=t.match(/\b(?:qty|quantity)\s+(?:to|is|=|now)\s*([\d]+(?:\s*\w+)?)/i); if(m) ch.Quantity=m[1].trim();
  m=t.match(/\brate\s+(?:to|is|=|now)\s*((?:₹|rs\.?)?\s*[\d,]+[\w/ ]*)/i); if(m) ch.Rate=m[1].trim();
  if(/\b(payment (?:received|done|cleared)|mark(?:ed)? paid|paid in full|fully paid|payment (?:as )?received)\b/i.test(t)) ch.Payment='Received';
  const st=statusFromVerb(low); if(st) ch.Status=st;
  return ch;
}
function detectUpdate(t,low,ctxId){
  const w={records:CURRENT_RECORDS};
  if(ctxId){ const ch=parseChanges(t,low); if(!Object.keys(ch).length) ch.Note=t.trim(); return {op:'update',recordId:ctxId,fields:ch}; }
  const strong=/\b(dispatch|dispatched|dispatching|shipp?ed|out for delivery|deliver(?:ed)?|cancel(?:led|ed)?|mark|marked|change|update|set|confirm(?:ed)?|ready|complete|completed|done|finished|close[d]?|reschedul|pack(?:ed|ing)?)\b/i.test(low)
    || /\bpayment (?:received|done|cleared)\b/i.test(low);
  if(!strong) return null;
  let best=null, bestScore=0;
  for(const r of w.records){
    const names=[recTitle(r),r.fields.Customer,r.fields.Name,r.fields.Client,r.fields.With,r.fields.For].filter(Boolean);
    for(const nm of names){ const n=String(nm).toLowerCase(); if(n.length<3) continue;
      if(new RegExp('\\b'+escRe(n)+'\\b','i').test(low)){
        let sc=n.length;
        if(/\border\b/.test(low)&&r.section==='Orders') sc+=50;
        if(/\bpayment\b/.test(low)&&r.section==='Payments') sc+=50;
        if(/\b(inquir|enquir)/.test(low)&&r.section==='Inquiries') sc+=50;
        if(sc>bestScore){ bestScore=sc; best=r; }
      }
    }
  }
  if(!best) return null;
  const ch=parseChanges(t,low);
  if(!Object.keys(ch).length){ const st=statusFromVerb(low); if(st) ch.Status=st; else return null; }
  return {op:'update',recordId:best.id,fields:ch};
}


export function localStructure(text: string, contextRecordId: string | null, recs: Rec[]) {
  CURRENT_RECORDS = recs;
  const t = text.trim(), low = t.toLowerCase();
  const upd = detectUpdate(t, low, contextRecordId);
  if (upd) return [upd];
  const cat = classify(low);
  return [{ op: "create", section: cat.section, sectionIcon: cat.icon, fields: buildFields(t, low, cat) }];
}

export function looksLikeQuestion(text: string) {
  const t = text.trim(), low = t.toLowerCase();
  return /\?\s*$/.test(t) || /^(how|what|whats|when|where|who|which|why|is|are|do|does|did|can|show|list|count|total|any)\b/.test(low);
}
