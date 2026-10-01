'use strict';
const { createHash, randomUUID } = require('node:crypto');
const EMAIL = 'Gworld0318@gmail.com';
const SERVICES = {homes:'Nettoyage de maisons',apartments:'Nettoyage d’appartements',commercial:'Nettoyage commercial',windows:'Lavage de vitres',floors:'Nettoyage de planchers',carpets:'Tapis et moquettes',furniture:'Meubles et tissus',deep:'Nettoyage en profondeur',buildings:'Entretien d’immeubles'};
const SPACES = {house:'Maison',apartment:'Appartement',business:'Commerce / bureau',building:'Immeuble'};
const FREQUENCIES = {once:'Ponctuelle',weekly:'Chaque semaine',biweekly:'Toutes les deux semaines',monthly:'Chaque mois'};
const REQUIRED = ['QUOTE_ALLOWED_ORIGINS','RESEND_API_KEY','QUOTE_EMAIL_FROM','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_WHATSAPP_FROM','TWILIO_WHATSAPP_TO','TWILIO_CONTENT_SID','UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN'];
const digest = text => createHash('sha256').update(text).digest('hex');
const clean = (value,max,required=false) => {
  if(typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('invalid');
  const result=value.trim(); if(required && !result)throw new Error('invalid'); return result;
};
function validate(body){
  if(!body || typeof body!=='object' || Array.isArray(body))throw new Error('invalid');
  const q={requestId:clean(body.requestId,36,true),language:body.language==='en'?'en':'fr',name:clean(body.name,120,true),email:clean(body.email,254,true),phone:clean(body.phone||'',40),message:clean(body.message||'',1800),space:body.space,service:body.service,location:body.location,frequency:body.frequency};
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(q.requestId)||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.email)||/[\r\n]/.test(q.name+q.phone)||!Object.hasOwn(SERVICES,q.service)||!Object.hasOwn(SPACES,q.space)||!Object.hasOwn(FREQUENCIES,q.frequency)||!['Montréal','Longueuil'].includes(q.location))throw new Error('invalid');
  return q;
}
async function redis(command){
  const r=await fetch(process.env.UPSTASH_REDIS_REST_URL,{method:'POST',headers:{Authorization:'Bearer '+process.env.UPSTASH_REDIS_REST_TOKEN,'Content-Type':'application/json'},body:JSON.stringify(command),signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error('storage');const data=await r.json();if(data.error)throw new Error('storage');return data.result;
}
function textFor(q){return `Nouvelle demande de soumission — G World\nRéférence : ${q.requestId}\n\nNom : ${q.name}\nCourriel : ${q.email}\nTéléphone : ${q.phone||'Non précisé'}\nLieu : ${SPACES[q.space]}\nService : ${SERVICES[q.service]}\nVille : ${q.location}\nFréquence : ${FREQUENCIES[q.frequency]}\nLangue : ${q.language.toUpperCase()}\n\nPrécisions : ${q.message||'Aucune précision'}`;}
async function sendEmail(q){
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'gworld/'+q.requestId},body:JSON.stringify({from:process.env.QUOTE_EMAIL_FROM,to:[EMAIL],reply_to:q.email,subject:'Nouvelle soumission — G World — '+q.name,text:textFor(q)}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)return {status:'failed'};const data=await r.json();return data.id?{status:'accepted',id:data.id}:{status:'uncertain'};
}
async function sendWhatsApp(q){
  const single=value=>String(value).replace(/\s+/g,' ').trim();
  const vars=[q.name,q.email,q.phone||'Non précisé',SPACES[q.space],SERVICES[q.service],q.location,FREQUENCIES[q.frequency],q.message||'Aucune précision',q.requestId];
  const form=new URLSearchParams({From:process.env.TWILIO_WHATSAPP_FROM,To:process.env.TWILIO_WHATSAPP_TO,ContentSid:process.env.TWILIO_CONTENT_SID,ContentVariables:JSON.stringify(Object.fromEntries(vars.map((v,i)=>[String(i+1),single(v)])))});
  const r=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(process.env.TWILIO_ACCOUNT_SID+':'+process.env.TWILIO_AUTH_TOKEN).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:form.toString(),signal:AbortSignal.timeout(10000)});
  if(!r.ok)return {status:r.status>=500?'uncertain':'failed'};const data=await r.json();return data.sid?{status:'accepted',id:data.sid}:{status:'uncertain'};
}
function publicState(state){return {email:state.email.status,whatsapp:state.whatsapp.status};}
module.exports=async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  const reply=(status,data)=>res.status(status).json(data);
  if(req.method!=='POST'){res.setHeader('Allow','POST');return reply(405,{error:'method'});}
  const origins=(process.env.QUOTE_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean);
  if(!origins.includes(req.headers.origin))return reply(403,{error:'origin'});
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))return reply(415,{error:'content_type'});
  if(Number(req.headers['content-length'])>12000)return reply(413,{error:'size'});
  let body,q;
  try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;if(Buffer.byteLength(JSON.stringify(body)||'')>12000)return reply(413,{error:'size'});q=validate(body);if(body.website)return reply(400,{error:'invalid'});}catch{return reply(400,{error:'invalid'});}
  if(REQUIRED.some(key=>!process.env[key]))return reply(503,{error:'not_configured'});
  if(!/^AC[0-9a-f]{32}$/i.test(process.env.TWILIO_ACCOUNT_SID)||!/^HX[0-9a-f]{32}$/i.test(process.env.TWILIO_CONTENT_SID)||!/^whatsapp:\+\d{8,15}$/.test(process.env.TWILIO_WHATSAPP_FROM)||!/^whatsapp:\+\d{8,15}$/.test(process.env.TWILIO_WHATSAPP_TO)||process.env.TWILIO_WHATSAPP_FROM===process.env.TWILIO_WHATSAPP_TO||!process.env.UPSTASH_REDIS_REST_URL.startsWith('https://'))return reply(503,{error:'not_configured'});
  const key='gworld:quote:'+q.requestId,lock=key+':lock',token=randomUUID();let locked=false;
  try{
    const ip=req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown';
    const rate=await redis(['EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",1,'gworld:rate:'+digest(String(ip).split(',')[0].trim())]);
    if(Number(rate)>8){res.setHeader('Retry-After','600');return reply(429,{error:'rate_limit'});}
    locked=await redis(['SET',lock,token,'NX','EX',90])==='OK';if(!locked)return reply(409,{error:'busy'});
    const hash=digest(JSON.stringify(q)),stored=await redis(['GET',key]);
    let state=stored?JSON.parse(stored):{hash,email:{status:'pending'},whatsapp:{status:'pending'}};
    if(state.hash!==hash)return reply(409,{error:'changed'});
    const save=()=>redis(['SET',key,JSON.stringify(state),'EX',86400]);
    await save();
    // Persist the intent before contacting providers. An interrupted WhatsApp send is
    // never retried blindly; a provider may have accepted it before the connection broke.
    if(['pending','failed','sending'].includes(state.email.status)){
      state.email={status:'sending'};await save();
      try{state.email=await sendEmail(q);}catch{state.email={status:'failed'};}await save();
    }
    if(state.whatsapp.status==='sending'){state.whatsapp={status:'uncertain'};await save();}
    if(['pending','failed'].includes(state.whatsapp.status)){
      state.whatsapp={status:'sending'};await save();
      try{state.whatsapp=await sendWhatsApp(q);}catch{state.whatsapp={status:'uncertain'};}await save();
    }
    const channels=publicState(state),ok=channels.email==='accepted'&&channels.whatsapp==='accepted';
    return reply(ok?200:channels.email==='accepted'||channels.whatsapp==='accepted'?207:502,{ok,reference:q.requestId,channels});
  }catch{return reply(503,{error:'unavailable'});}
  finally{if(locked){try{await redis(['EVAL',"if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",1,lock,token]);}catch{/* Lease expires automatically. */}}}
};
