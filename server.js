import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const {Pool}=pg;
const app=express();
const PORT=process.env.PORT||10000;
const JWT_SECRET=process.env.JWT_SECRET||'CHANGE_ME_IN_RENDER';
const ADMIN_USERNAME=(process.env.ADMIN_USERNAME||'admin').trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'';
const DATABASE_URL=process.env.DATABASE_URL||'';

app.set('trust proxy',1);
app.use(cors({origin:true,credentials:false}));
app.use(express.json({limit:'50mb'}));

const pool=DATABASE_URL?new Pool({connectionString:DATABASE_URL,ssl:{rejectUnauthorized:false},max:5}):null;
const mem=new Map();

async function db(sql,args=[]){
  if(!pool) return null;
  return pool.query(sql,args);
}
async function init(){
  if(!pool) return;
  await db(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT NOT NULL)`);
  await db(`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, is_admin BOOLEAN NOT NULL DEFAULT FALSE, suspended BOOLEAN NOT NULL DEFAULT FALSE, created_at BIGINT NOT NULL)`);
}

function signUser(u){return jwt.sign({sub:u.username,isAdmin:!!u.isAdmin},JWT_SECRET,{expiresIn:'30d'});}
function auth(req,res,next){
  const h=req.get('authorization')||'';
  if(!h.startsWith('Bearer ')) return res.status(401).json({error:'auth_required'});
  try{req.user=jwt.verify(h.slice(7),JWT_SECRET);next();}catch{return res.status(401).json({error:'invalid_token'});}
}
function optionalAuth(req){
  const h=req.get('authorization')||'';
  if(!h.startsWith('Bearer ')) return null;
  try{return jwt.verify(h.slice(7),JWT_SECRET);}catch{return null;}
}
function keyOk(k){return typeof k==='string'&&k.length>0&&k.length<=500&&!/[\0\n\r]/.test(k);}

app.get('/api/health',async(req,res)=>{
  try{if(pool) await db('SELECT 1');res.json({ok:true,service:'vira',database:!!pool});}
  catch(e){res.status(503).json({ok:false,error:'database_unavailable'});}
});

app.post('/api/register',async(req,res)=>{
  const username=String(req.body?.username||'').trim().toLowerCase();
  const password=String(req.body?.password||'');
  if(!/^[a-z0-9_]{3,20}$/.test(username)||password.length<4) return res.status(400).json({error:'invalid_input'});
  if(username===ADMIN_USERNAME) return res.status(409).json({error:'reserved'});
  try{
    if(pool){
      const exists=await db('SELECT username FROM users WHERE username=$1',[username]);
      if(exists.rowCount) return res.status(409).json({error:'exists'});
      const hash=await bcrypt.hash(password,12);
      await db('INSERT INTO users(username,password_hash,is_admin,suspended,created_at) VALUES($1,$2,FALSE,FALSE,$3)',[username,hash,Date.now()]);
    }else{
      if(mem.has('user:'+username)) return res.status(409).json({error:'exists'});
      mem.set('user:'+username,{username,passwordHash:await bcrypt.hash(password,12),isAdmin:false,suspended:false});
    }
    const token=signUser({username,isAdmin:false});
    res.json({ok:true,username,token,isAdmin:false});
  }catch(e){console.error(e);res.status(500).json({error:'register_failed'});}
});

app.post('/api/login',async(req,res)=>{
  const username=String(req.body?.username||'').trim().toLowerCase();
  const password=String(req.body?.password||'');
  try{
    if(username===ADMIN_USERNAME && ADMIN_PASSWORD && password===ADMIN_PASSWORD){
      return res.json({ok:true,username,isAdmin:true,token:signUser({username,isAdmin:true})});
    }
    let u;
    if(pool){const r=await db('SELECT username,password_hash,is_admin,suspended FROM users WHERE username=$1',[username]);u=r.rows[0];}
    else u=mem.get('user:'+username);
    if(!u) return res.status(401).json({error:'invalid_credentials'});
    const hash=u.password_hash||u.passwordHash;
    if(!(await bcrypt.compare(password,hash))) return res.status(401).json({error:'invalid_credentials'});
    if(u.suspended) return res.status(403).json({error:'suspended'});
    res.json({ok:true,username:u.username,isAdmin:!!u.is_admin||!!u.isAdmin,token:signUser({username:u.username,isAdmin:!!u.is_admin||!!u.isAdmin})});
  }catch(e){console.error(e);res.status(500).json({error:'login_failed'});}
});

app.get('/api/kv/:key',async(req,res)=>{
  const key=req.params.key;if(!keyOk(key))return res.status(400).json({error:'bad_key'});
  try{
    if(pool){const r=await db('SELECT value FROM kv WHERE key=$1',[key]);if(!r.rowCount)return res.status(404).json({error:'not_found'});return res.json({key,value:r.rows[0].value});}
    if(!mem.has('kv:'+key))return res.status(404).json({error:'not_found'});res.json({key,value:mem.get('kv:'+key)});
  }catch(e){res.status(500).json({error:'kv_get_failed'});}
});

app.get('/api/kv',async(req,res)=>{
  const prefix=String(req.query.prefix||'');if(prefix.length>500)return res.status(400).json({error:'bad_prefix'});
  try{
    if(pool){const r=await db('SELECT key,value FROM kv WHERE key LIKE $1 ORDER BY key LIMIT 5000',[prefix+'%']);const out={keys:r.rows.map(x=>x.key)};if(req.query.values==='1')out.items=Object.fromEntries(r.rows.map(x=>[x.key,x.value]));return res.json(out);}
    const keys=[...mem.keys()].filter(k=>k.startsWith('kv:')).map(k=>k.slice(3)).filter(k=>k.startsWith(prefix)).sort().slice(0,5000);const out={keys};if(req.query.values==='1')out.items=Object.fromEntries(keys.map(k=>[k,mem.get('kv:'+k)]));res.json(out);
  }catch(e){res.status(500).json({error:'kv_list_failed'});}
});

app.put('/api/kv/:key',auth,async(req,res)=>{
  const key=req.params.key;const value=req.body?.value;
  if(!keyOk(key)||typeof value!=='string'||value.length>50*1024*1024)return res.status(400).json({error:'bad_value'});
  try{
    if(pool) await db(`INSERT INTO kv(key,value,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,[key,value,Date.now()]);
    else mem.set('kv:'+key,value);
    res.json({ok:true,key,value});
  }catch(e){console.error(e);res.status(500).json({error:'kv_set_failed'});}
});

app.delete('/api/kv/:key',auth,async(req,res)=>{
  const key=req.params.key;if(!keyOk(key))return res.status(400).json({error:'bad_key'});
  try{if(pool)await db('DELETE FROM kv WHERE key=$1',[key]);else mem.delete('kv:'+key);res.json({ok:true,deleted:true});}
  catch(e){res.status(500).json({error:'kv_delete_failed'});}
});

// Lightweight app-level operations reserved for future expansion.
app.get('/api/me',auth,(req,res)=>res.json({ok:true,user:req.user}));

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.join(__dirname,'public');
app.use(express.static(publicDir,{extensions:['html']}));
app.get('*',(req,res)=>res.sendFile(path.join(publicDir,'index.html')));

init().then(()=>app.listen(PORT,()=>console.log(`Vira server listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1);});
