// One local control-plane connection. Never expose this DB to model file tools.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { gateError } from './plan.js';

export class EgressLedger {
  constructor(filename, keyId) {
    this.db = new DatabaseSync(filename);
    try {
    this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS gate_meta (id INTEGER PRIMARY KEY CHECK(id=1), key_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_tasks (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
        manifest TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_dispatches (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, session TEXT NOT NULL, digest TEXT NOT NULL,
        origin TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL, finished INTEGER);
      CREATE TABLE IF NOT EXISTS gate_denials (session TEXT NOT NULL, digest TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(session,digest));
      CREATE TABLE IF NOT EXISTS gate_members (session TEXT NOT NULL, task TEXT NOT NULL, digest TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY(task,digest));
      CREATE INDEX IF NOT EXISTS gate_members_request ON gate_members(session,digest);
      CREATE TABLE IF NOT EXISTS gate_resource_blocks (session TEXT NOT NULL, resource TEXT NOT NULL, task TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(session,resource,task));
      CREATE TABLE IF NOT EXISTS gate_review_required (session TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY(session,resource));
      CREATE TABLE IF NOT EXISTS gate_reconciliations (id TEXT PRIMARY KEY, session TEXT NOT NULL, task TEXT NOT NULL, disposition TEXT NOT NULL, evidence TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gate_origins (origin TEXT PRIMARY KEY, next_start INTEGER NOT NULL, inflight TEXT);
    `);
    this.transaction(() => {
      const old = this.db.prepare('SELECT key_id FROM gate_meta WHERE id=1').get();
      if (old && old.key_id !== keyId) throw gateError('LEDGER_KEY_CHANGED');
      this.db.prepare('INSERT OR IGNORE INTO gate_meta VALUES (1,?)').run(keyId);
      // Old manifests without resource identities must not remain usable after upgrade.
      this.db.exec(`INSERT OR IGNORE INTO gate_members
        SELECT t.session,t.id,json_extract(e.value,'$.digest'),json_extract(e.value,'$.resource')
        FROM gate_tasks t,json_each(t.manifest,'$.entries') e WHERE json_extract(e.value,'$.resource') IS NOT NULL;
        INSERT OR IGNORE INTO gate_resource_blocks
        SELECT m.session,m.resource,m.task,'stale_pending' FROM gate_members m JOIN gate_tasks t ON t.id=m.task WHERE t.state='pending';
        INSERT OR REPLACE INTO gate_resource_blocks
        SELECT m.session,m.resource,m.task,'outcome_unknown' FROM gate_members m JOIN gate_dispatches d ON d.task=m.task AND d.digest=m.digest WHERE d.state='dispatching';`);
      // A crash cannot silently renew permission or retry a possibly sent request.
      this.db.exec(`INSERT OR IGNORE INTO gate_denials SELECT session,digest,'outcome_unknown' FROM gate_dispatches WHERE state='dispatching';
        UPDATE gate_dispatches SET state='outcome_unknown' WHERE state='dispatching';
        UPDATE gate_tasks SET state='revoked' WHERE state IN ('pending','active');
        UPDATE gate_origins SET inflight=NULL;`);
    });
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  add(session, digest, manifest, state) {
    return this.transaction(() => {
      for (const entry of manifest.entries) this.assertNotDenied(session, entry.digest);
      const id = randomUUID();
      if (manifest.entries.some(entry => !entry.resource)) throw gateError('MISSING_RESOURCE_BINDING');
      if (state === 'active' && manifest.entries.some(entry => this.resourceBlocked(session, entry.resource)||this.requiresReview(session,entry.resource))) state = 'pending';
      for (const entry of manifest.entries) {
        this.db.prepare('INSERT INTO gate_members VALUES (?,?,?,?)').run(session,id,entry.digest,entry.resource);
        if (state === 'pending') this.db.prepare('INSERT OR IGNORE INTO gate_resource_blocks VALUES (?,?,?,?)').run(session,entry.resource,id,'pending');
      }
      this.db.prepare('INSERT INTO gate_tasks (id,session,digest,state,manifest,expires) VALUES (?,?,?,?,?,?)')
        .run(id, session, digest, state, JSON.stringify(manifest), manifest.expiresAt);
      return { id, digest, state, expiresAt: manifest.expiresAt };
    });
  }
  supersede(session,oldId,oldDigest,newDigest,manifest) {
    return this.transaction(()=>{
      const old=this.get(session,oldId);
      if(old.state!=='pending'||old.used!==0||old.digest!==oldDigest)throw gateError('STALE_APPROVAL');
      for(const entry of manifest.entries)this.assertNotDenied(session,entry.digest);
      const id=randomUUID();
      this.db.prepare("INSERT INTO gate_tasks (id,session,digest,state,manifest,expires) VALUES (?,?,?,'pending',?,?)")
        .run(id,session,newDigest,JSON.stringify(manifest),manifest.expiresAt);
      for(const entry of manifest.entries){
        this.db.prepare('INSERT INTO gate_members VALUES (?,?,?,?)').run(session,id,entry.digest,entry.resource);
        this.db.prepare('INSERT INTO gate_resource_blocks VALUES (?,?,?,?)').run(session,entry.resource,id,'pending');
      }
      this.db.prepare("UPDATE gate_tasks SET state='superseded' WHERE id=?").run(oldId);
      this.db.prepare("DELETE FROM gate_resource_blocks WHERE session=? AND task=? AND reason='pending'").run(session,oldId);
      return {id,digest:newDigest,state:'pending',expiresAt:manifest.expiresAt};
    });
  }
  requiresReview(session,resource) {
    return !!this.db.prepare('SELECT 1 FROM gate_review_required WHERE session=? AND resource=?').get(session,resource);
  }
  resourceBlocked(session, resource, exceptTask = '') {
    return !!this.db.prepare('SELECT 1 FROM gate_resource_blocks WHERE session=? AND resource=? AND task<>? LIMIT 1').get(session,resource,exceptTask);
  }
  find(session, digest) {
    const rows = this.db.prepare("SELECT t.* FROM gate_tasks t JOIN gate_members m ON m.task=t.id WHERE m.session=? AND m.digest=? AND t.state NOT IN ('superseded','reconciled') ORDER BY t.rowid DESC").all(session,digest);
    const row = rows.find(row => ['pending','denied'].includes(row.state)) ?? rows.find(row => row.state === 'active') ?? rows[0];
    return row && { id:row.id, digest:row.digest, state:row.state, expiresAt:row.expires };
  }
  assertNotDenied(session, digest) {
    if (this.db.prepare('SELECT 1 FROM gate_denials WHERE session=? AND digest=?').get(session, digest)) throw gateError('PREVIOUSLY_DENIED_OR_UNKNOWN');
  }
  get(session, id) {
    const task = this.db.prepare('SELECT * FROM gate_tasks WHERE session=? AND id=?').get(session, id);
    if (!task) throw gateError('UNKNOWN_TASK');
    return { ...task, manifest: JSON.parse(task.manifest) };
  }
  decide(session, id, digest, action, now) {
    return this.transaction(() => {
      const task = this.get(session, id);
      if (task.digest !== digest || task.state !== 'pending' || task.expires <= now) throw gateError('STALE_APPROVAL');
      if (!['allow', 'reject'].includes(action)) throw gateError('INVALID_DECISION');
      if (action === 'reject') {
        for (const entry of task.manifest.entries) {
          this.db.prepare('INSERT OR IGNORE INTO gate_denials VALUES (?,?,?)').run(session, entry.digest, 'human_rejected');
          this.db.prepare('INSERT OR REPLACE INTO gate_resource_blocks VALUES (?,?,?,?)').run(session,entry.resource,id,'human_rejected');
        }
      } else for (const entry of task.manifest.entries) this.assertNotDenied(session, entry.digest);
      if (action === 'allow') this.db.prepare("DELETE FROM gate_resource_blocks WHERE session=? AND task=? AND reason='pending'").run(session,id);
      const state = action === 'allow' ? 'active' : 'denied';
      if(action==='allow')task.manifest.humanApproved=true;
      this.db.prepare('UPDATE gate_tasks SET state=?,manifest=? WHERE id=?').run(state,JSON.stringify(task.manifest),id);
      return { id, state, digest };
    });
  }
  claim(session, id, digest, origin, now, lane = 'proxy') {
    return this.transaction(() => {
      const task = this.get(session, id);
      if (task.state !== 'active') throw gateError('TASK_NOT_ACTIVE');
      if((task.manifest.lane??'proxy')!==lane)throw gateError('WRONG_EXECUTION_LANE');
      if (task.expires <= now) throw gateError('EXPIRED');
      this.assertNotDenied(session, digest);
      const entry = task.manifest.entries.find(entry => entry.digest === digest);
      if (!entry) throw gateError('REQUEST_NOT_APPROVED');
      if(this.requiresReview(session,entry.resource)&&task.manifest.humanApproved!==true)throw gateError('RESOURCE_REQUIRES_REVIEW');
      if(this.resourceBlocked(session,entry.resource,id))throw gateError('RESOURCE_REQUIRES_REVIEW');
      if (task.used >= task.manifest.maxRequests || entry.used >= entry.maxRequests) throw gateError('BUDGET_EXHAUSTED');
      const rate = this.db.prepare('SELECT * FROM gate_origins WHERE origin=?').get(origin);
      if (rate?.inflight) throw gateError('ORIGIN_BUSY');
      if (rate && rate.next_start > now) throw gateError('RATE_LIMIT');
      const dispatchId = randomUUID();
      entry.used++;
      this.db.prepare('UPDATE gate_tasks SET used=used+1,manifest=? WHERE id=?').run(JSON.stringify(task.manifest), id);
      this.db.prepare('INSERT INTO gate_dispatches VALUES (?,?,?,?,?,?,?,NULL)').run(dispatchId, id, session, digest, origin, 'dispatching', now);
      this.db.prepare('INSERT INTO gate_origins VALUES (?,?,?) ON CONFLICT(origin) DO UPDATE SET next_start=excluded.next_start,inflight=excluded.inflight')
        .run(origin, now + task.manifest.minIntervalMs, dispatchId);
      return { dispatchId };
    });
  }
  finish(session, dispatchId, outcome, now) {
    if (!['response_received', 'outcome_unknown'].includes(outcome)) throw gateError('INVALID_OUTCOME');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM gate_dispatches WHERE id=? AND session=?').get(dispatchId, session);
      if (!row || row.state !== 'dispatching') throw gateError('DISPATCH_NOT_ACTIVE');
      this.db.prepare('UPDATE gate_dispatches SET state=?,finished=? WHERE id=?').run(outcome, now, dispatchId);
      this.db.prepare('UPDATE gate_origins SET inflight=NULL WHERE origin=? AND inflight=?').run(row.origin, dispatchId);
      if (outcome === 'outcome_unknown') {
        this.db.prepare('INSERT OR IGNORE INTO gate_denials VALUES (?,?,?)').run(session, row.digest, outcome);
        const member=this.db.prepare('SELECT resource FROM gate_members WHERE task=? AND digest=?').get(row.task,row.digest);
        if(member)this.db.prepare('INSERT OR REPLACE INTO gate_resource_blocks VALUES (?,?,?,?)').run(session,member.resource,row.task,outcome);
        this.db.prepare("UPDATE gate_tasks SET state='revoked' WHERE id=?").run(row.task);
      }
    });
  }
  reconcile(session,id,disposition,evidence,now) {
    return this.transaction(()=>{
      const task=this.get(session,id);
      if(!['cancel-never-sent','confirmed-not-applied','confirmed-applied','withdraw-rejection'].includes(disposition)||typeof evidence!=='string'||evidence.trim().length<20||evidence.length>4096)throw gateError('RECONCILIATION_EVIDENCE_REQUIRED');
      if(this.db.prepare("SELECT 1 FROM gate_dispatches WHERE task=? AND state='dispatching'").get(id))throw gateError('DISPATCH_STILL_ACTIVE');
      if(['superseded','reconciled'].includes(task.state)||(task.state==='active'&&task.expires>now))throw gateError('RECONCILIATION_NOT_ALLOWED');
      if(disposition==='cancel-never-sent'&&task.used!==0)throw gateError('REQUEST_MAY_HAVE_BEEN_SENT');
      if(disposition==='withdraw-rejection'&&task.state!=='denied')throw gateError('NOT_REJECTED');
      for(const entry of task.manifest.entries){
        this.db.prepare('INSERT OR IGNORE INTO gate_review_required VALUES (?,?)').run(session,entry.resource);
        this.db.prepare('DELETE FROM gate_resource_blocks WHERE session=? AND resource=? AND task=?').run(session,entry.resource,id);
        const other=this.db.prepare('SELECT 1 FROM gate_members m JOIN gate_resource_blocks b ON b.session=m.session AND b.resource=m.resource AND b.task=m.task WHERE m.session=? AND m.digest=? LIMIT 1').get(session,entry.digest);
        if(!other)this.db.prepare('DELETE FROM gate_denials WHERE session=? AND digest=?').run(session,entry.digest);
      }
      this.db.prepare("UPDATE gate_tasks SET state='reconciled' WHERE id=?").run(id);
      this.db.prepare('INSERT INTO gate_reconciliations VALUES (?,?,?,?,?,?)').run(randomUUID(),session,id,disposition,evidence.trim(),now);
      return {id,state:'reconciled',requiresFreshHumanApproval:true};
    });
  }
  quarantine(session,id) {
    return this.transaction(()=>{
      const task=this.get(session,id);
      for(const entry of task.manifest.entries){
        this.db.prepare('INSERT OR IGNORE INTO gate_denials VALUES (?,?,?)').run(session,entry.digest,'outcome_unknown');
        this.db.prepare('INSERT OR REPLACE INTO gate_resource_blocks VALUES (?,?,?,?)').run(session,entry.resource,id,'outcome_unknown');
      }
      this.db.prepare("UPDATE gate_tasks SET state='revoked' WHERE id=?").run(id);
    });
  }
  revoke(session, id) {
    this.db.prepare("UPDATE gate_tasks SET state='revoked' WHERE session=? AND id=? AND state IN ('active','pending')").run(session, id);
  }
  close() { this.db.close(); }
}
