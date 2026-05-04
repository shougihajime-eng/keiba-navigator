"use strict";
// KEIBA NAVIGATOR — ストレージ抽象化レイヤ (ブラウザ実行)
//
// 仕様:
//   - Supabase 設定済 + ログイン済 → クラウド (Supabase)
//   - それ以外 → localStorage (フォールバック)
//   - 全 API は async (Supabase 互換)
//   - ログイン時に localStorage の既存データを Supabase へ自動アップロード可能
//
// 公開 API:
//   await Storage.init()          初期化 (DOMContentLoaded時に1回)
//   Storage.mode                   'cloud' | 'local' | 'cloud-anon'
//   Storage.user                   現在のユーザー (Supabase) | null
//   Storage.onChange(cb)           モード/ユーザー変更時のコールバック
//   await Storage.signIn(email)    Magic link 送信
//   await Storage.signOut()
//   await Storage.load()           { funds, strategy, risk, bets, version }
//   await Storage.save(state)      { ok: boolean, error?: string }
//   await Storage.migrateToCloud() localStorage → Supabase へ既存データ移行

(function (global) {
  const LS_KEY = "keiba_nav_v1";
  const LS_TMP = LS_KEY + ":tmp";
  const LS_BAK = LS_KEY + ":bak";
  const STORE_VERSION = 1;
  const QUOTA_TRIM_KEEP = 4000;

  const listeners = new Set();
  let _supabase = null;
  let _user = null;
  let _mode = "local"; // 'cloud' | 'cloud-anon' | 'local'
  let _initialized = false;

  function defaultStore() {
    return {
      version: STORE_VERSION,
      funds: { daily: null, perRace: null, minEv: 1.10 },
      strategy: "balance",
      risk: "tight",
      bets: [],
    };
  }

  function migrateStore(parsed) {
    if (!parsed || typeof parsed !== "object") return defaultStore();
    if (!parsed.version) parsed.version = STORE_VERSION;
    if (!parsed.funds || typeof parsed.funds !== "object") parsed.funds = defaultStore().funds;
    if (!Array.isArray(parsed.bets)) parsed.bets = [];
    if (typeof parsed.strategy !== "string") parsed.strategy = "balance";
    if (typeof parsed.risk !== "string") parsed.risk = "tight";
    return parsed;
  }

  function notify() {
    for (const cb of listeners) {
      try { cb({ mode: _mode, user: _user }); } catch (e) { console.warn(e); }
    }
  }

  // ─── localStorage バックエンド ────────────────────────────
  let _loadCorruptionDetected = false;

  function lsLoad() {
    let raw = null;
    try {
      raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultStore();
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) throw new Error("invalid_format");
      return Object.assign(defaultStore(), migrateStore(parsed));
    } catch (e) {
      try {
        if (raw) localStorage.setItem(LS_BAK + "_" + Date.now(), raw);
      } catch {}
      _loadCorruptionDetected = true;
      return defaultStore();
    }
  }

  function lsSave(s) {
    return _lsSaveInner(s, 0);
  }

  function _lsSaveInner(s, retry) {
    try {
      const json = JSON.stringify(s);
      localStorage.setItem(LS_TMP, json);
      const back = localStorage.getItem(LS_TMP);
      if (back !== json) throw new Error("verify_failed");
      localStorage.setItem(LS_KEY, json);
      try { localStorage.removeItem(LS_TMP); } catch {}
      return { ok: true };
    } catch (e) {
      const isQuota = e && (e.name === "QuotaExceededError" || /quota/i.test(String(e.message || e)));
      if (isQuota && retry < 1 && Array.isArray(s.bets) && s.bets.length > QUOTA_TRIM_KEEP) {
        const trimmed = [...s.bets].sort((a, b) => (b.ts || "").localeCompare(a.ts || "")).slice(0, QUOTA_TRIM_KEEP);
        s.bets = trimmed;
        return _lsSaveInner(s, retry + 1);
      }
      return { ok: false, error: String(e.message || e) };
    }
  }

  // ─── Supabase バックエンド ────────────────────────────────
  function isCloudConfigured() {
    const cfg = global.KEIBA_CONFIG || {};
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && global.supabase);
  }

  async function initSupabase() {
    if (!isCloudConfigured()) {
      _mode = "local";
      return false;
    }
    const cfg = global.KEIBA_CONFIG;
    _supabase = global.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
    // セッション復元
    try {
      const { data: { session } } = await _supabase.auth.getSession();
      _user = session?.user || null;
    } catch { _user = null; }
    _mode = _user ? "cloud" : "cloud-anon";

    // 認証イベントを購読
    _supabase.auth.onAuthStateChange((_event, session) => {
      const wasUser = _user;
      _user = session?.user || null;
      _mode = _user ? "cloud" : (isCloudConfigured() ? "cloud-anon" : "local");
      if ((wasUser?.id || null) !== (_user?.id || null)) notify();
    });
    return true;
  }

  function _betDbRow(b, userId) {
    return {
      id: b.id,
      user_id: userId,
      ts: b.ts,
      type: b.type,
      amount: Math.round(b.amount || 0),
      race_name: b.raceName ?? null,
      race_id: b.raceId ?? b.race_id ?? null,
      target: b.target ?? null,
      bet_type: b.betType ?? "tan",
      odds: b.odds ?? null,
      prob: b.prob ?? null,
      ev: b.ev ?? null,
      grade: b.grade ?? null,
      data_source: b.dataSource ?? "unknown",
      result: b.result ?? null,
      factors: Array.isArray(b.factors) ? b.factors : null,
      profit: typeof b.profit === "number" ? Math.round(b.profit) : null,
      auto_saved: !!b.auto,
    };
  }

  function _rowToBet(row) {
    return {
      id: row.id,
      ts: row.ts,
      type: row.type,
      amount: row.amount,
      raceName: row.race_name,
      raceId: row.race_id,
      target: row.target,
      betType: row.bet_type,
      odds: row.odds != null ? Number(row.odds) : null,
      prob: row.prob != null ? Number(row.prob) : null,
      ev:   row.ev   != null ? Number(row.ev)   : null,
      grade: row.grade,
      dataSource: row.data_source,
      result: row.result,
      factors: row.factors || [],
      profit: row.profit,
      auto: !!row.auto_saved,
    };
  }

  async function cloudLoad() {
    if (!_supabase || !_user) return null;
    try {
      const [s, b] = await Promise.all([
        _supabase.from("user_settings").select("*").eq("user_id", _user.id).maybeSingle(),
        _supabase.from("bets").select("*").eq("user_id", _user.id).order("ts", { ascending: false }),
      ]);
      const settings = s.data || {};
      const bets = (b.data || []).map(_rowToBet);
      return Object.assign(defaultStore(), {
        funds: settings.funds || defaultStore().funds,
        strategy: settings.strategy || "balance",
        risk: settings.risk || "tight",
        version: settings.version || STORE_VERSION,
        bets,
      });
    } catch (e) {
      console.warn("[Storage] cloud load failed, falling back:", e);
      return null;
    }
  }

  async function cloudSave(s) {
    if (!_supabase || !_user) return { ok: false, error: "not_signed_in" };
    try {
      // settings upsert
      const { error: e1 } = await _supabase.from("user_settings").upsert({
        user_id: _user.id,
        funds: s.funds,
        strategy: s.strategy,
        risk: s.risk,
        version: s.version || STORE_VERSION,
        updated_at: new Date().toISOString(),
      });
      if (e1) throw e1;
      // bets: 一括 upsert (id衝突は更新)
      if (Array.isArray(s.bets) && s.bets.length > 0) {
        const rows = s.bets.map(b => _betDbRow(b, _user.id));
        // チャンク化 (Supabase の payload 上限を避ける)
        const chunkSize = 500;
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize);
          const { error } = await _supabase.from("bets").upsert(chunk);
          if (error) throw error;
        }
      }
      return { ok: true };
    } catch (e) {
      console.warn("[Storage] cloud save failed:", e);
      return { ok: false, error: String(e.message || e) };
    }
  }

  async function cloudDeleteBet(id) {
    if (!_supabase || !_user) return;
    try { await _supabase.from("bets").delete().eq("id", id).eq("user_id", _user.id); }
    catch (e) { console.warn("[Storage] cloud delete failed:", e); }
  }

  // ─── 公開 API ─────────────────────────────────────────────
  const Storage = {
    get mode() { return _mode; },
    get user() { return _user; },
    get cloudConfigured() { return isCloudConfigured(); },
    get loadCorruptionDetected() { return _loadCorruptionDetected; },

    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },

    async init() {
      if (_initialized) return;
      _initialized = true;
      await initSupabase();
      notify();
    },

    async signIn(email) {
      if (!_supabase) throw new Error("Supabase 未設定です。config.js に SUPABASE_URL と SUPABASE_ANON_KEY を入れてください。");
      const redirect = location.origin + location.pathname;
      const { error } = await _supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
      if (error) throw error;
    },

    async signOut() {
      if (!_supabase) return;
      try { await _supabase.auth.signOut(); } catch {}
      _user = null;
      _mode = isCloudConfigured() ? "cloud-anon" : "local";
      notify();
    },

    async load() {
      if (_mode === "cloud") {
        const r = await cloudLoad();
        if (r) return r;
        // クラウド失敗時はlocalStorageへ
      }
      return lsLoad();
    },

    async save(state) {
      if (_mode === "cloud") {
        const r = await cloudSave(state);
        if (r.ok) {
          // ローカルにもキャッシュ (オフライン耐性)
          try { lsSave(state); } catch {}
          return r;
        }
        // 失敗時はlocalStorageへフォールバック
      }
      return lsSave(state);
    },

    async deleteBet(id) {
      if (_mode === "cloud") await cloudDeleteBet(id);
      // localStorage 側も更新は呼出し元で行う (state 操作のため)
    },

    async migrateToCloud() {
      if (_mode !== "cloud") {
        return { ok: false, error: "Supabase にログインしていません" };
      }
      const local = lsLoad();
      const r = await cloudSave(local);
      return r;
    },
  };

  global.Storage = Storage;
})(typeof window !== "undefined" ? window : globalThis);
