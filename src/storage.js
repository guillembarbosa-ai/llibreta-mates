'use strict';

// Fitxers pujats: Supabase Storage a producció, disc local en desenvolupament.
// La interfície és la mateixa per a tots dos casos.

const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const { UPLOADS_DIR } = require('./db');

const BUCKET = process.env.SUPABASE_BUCKET || 'lliuraments';

const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

function isRemote() {
  return Boolean(supabase);
}

async function ensureBucket() {
  if (!supabase) return;
  const { data } = await supabase.storage.getBucket(BUCKET);
  if (data) return;
  await supabase.storage.createBucket(BUCKET, { public: false, fileSizeLimit: 10 * 1024 * 1024 });
}

function safeName(name) {
  return path.basename(String(name || ''));
}

async function saveUpload(name, buffer, mime) {
  const safe = safeName(name);
  if (supabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(safe, buffer, {
      contentType: mime || 'application/octet-stream',
      upsert: true,
    });
    if (error) throw error;
  } else {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, safe), buffer);
  }
  return safe;
}

async function deleteUpload(name) {
  const safe = safeName(name);
  if (!safe) return;
  if (supabase) {
    await supabase.storage.from(BUCKET).remove([safe]);
  } else {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, safe)); } catch { /* ja absent */ }
  }
}

async function hasUpload(name) {
  const safe = safeName(name);
  if (!safe) return false;
  if (supabase) {
    const { data, error } = await supabase.storage.from(BUCKET).download(safe);
    return !error && Boolean(data);
  }
  return fs.existsSync(path.join(UPLOADS_DIR, safe));
}

/** Desa el fitxer a la resposta. Retorna false si no existeix. */
async function sendUpload(name, mime, downloadName, res) {
  const safe = safeName(name);
  if (!safe) return false;

  if (supabase) {
    const { data, error } = await supabase.storage.from(BUCKET).download(safe);
    if (error || !data) return false;
    const buffer = Buffer.from(await data.arrayBuffer());
    const filename = String(downloadName || 'lliurament').replace(/["\r\n]/g, '_');
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    return true;
  }

  const filePath = path.join(UPLOADS_DIR, safe);
  if (!fs.existsSync(filePath)) return false;
  res.download(filePath, downloadName || 'lliurament');
  return true;
}

module.exports = { isRemote, ensureBucket, saveUpload, deleteUpload, hasUpload, sendUpload, BUCKET };
