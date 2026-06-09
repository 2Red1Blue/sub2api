// ==UserScript==
// @name         Sub2API 账号模型巡检并自动下线
// @namespace    https://sinry.example
// @version      0.1.3
// @description  按当前页面分组批量测试账号模型；任一模型异常时自动关闭账号 schedulable；已关闭调度账号跳过
// @match        http://127.0.0.1:18080/admin/accounts*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    apiBase: location.origin,
    pageSize: 100,
    defaultTimeoutMs: 45000,
    defaultConcurrency: 8,
    maxConcurrency: 50,
    prompt: 'hi',
    onlyCheckSchedulable: false,
    stopOnFirstModelFailure: true,
    preferredModels: ['gpt-5.4', 'gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'],
    defaultTestModel: 'gpt-5.4',
    groupParamNames: ['group', 'groups', 'account_group', 'accountGroup'],
    pageAuthTokenKey: 'auth_token',
    authStorageKey: '__sub2api_checker_auth__',
    timeoutStorageKey: '__sub2api_checker_timeout_ms__',
    concurrencyStorageKey: '__sub2api_checker_concurrency__',
    testModelStorageKey: '__sub2api_checker_test_model__',
    currentGroupStorageKey: '__sub2api_checker_current_group__',
    autoDisableStorageKey: '__sub2api_checker_auto_disable__',
  };

  const groupIDCache = new Map();

  function getCachedAuthToken() {
    const raw =
      localStorage.getItem(CONFIG.pageAuthTokenKey) ||
      sessionStorage.getItem(CONFIG.pageAuthTokenKey) ||
      localStorage.getItem(CONFIG.authStorageKey) ||
      '';
    return raw ? (raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`) : '';
  }

  function clampConcurrency(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return CONFIG.defaultConcurrency;
    return Math.min(CONFIG.maxConcurrency, Math.max(1, n));
  }

  function readSavedConcurrency() {
    return clampConcurrency(localStorage.getItem(CONFIG.concurrencyStorageKey) || CONFIG.defaultConcurrency);
  }

  function readSavedAutoDisable() {
    return localStorage.getItem(CONFIG.autoDisableStorageKey) !== 'false';
  }

  const state = {
    authHeader: getCachedAuthToken(),
    timeoutMs: Number(localStorage.getItem(CONFIG.timeoutStorageKey) || CONFIG.defaultTimeoutMs),
    concurrency: readSavedConcurrency(),
    testModel: localStorage.getItem(CONFIG.testModelStorageKey) || CONFIG.defaultTestModel,
    autoDisable: readSavedAutoDisable(),
    currentGroup: normalizeGroup(localStorage.getItem(CONFIG.currentGroupStorageKey)),
    running: false,
    stopRequested: false,
    panelReady: false,
    collapsed: true,
    stats: {
      total: 0,
      checked: 0,
      active: 0,
      started: 0,
      ok: 0,
      enabled: 0,
      disabled: 0,
      skipped: 0,
      failed: 0,
    },
  };

  function log(msg, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${msg}`;
    console[type === 'error' ? 'error' : 'log'](`[sub2api-checker] ${line}`);
    const box = document.querySelector('#sub2api-checker-log');
    if (!box) return;
    const color =
      type === 'error' ? '#ff7875' :
      type === 'warn' ? '#ffd666' :
      type === 'success' ? '#95de64' : '#d9d9d9';
    const row = document.createElement('div');
    row.style.color = color;
    row.textContent = line;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function saveAuth(auth) {
    if (!auth || typeof auth !== 'string') return;
    const normalized = auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`;
    const changed = state.authHeader !== normalized;
    state.authHeader = normalized;
    localStorage.setItem(CONFIG.authStorageKey, normalized);
    const input = document.querySelector('#sub2api-checker-auth');
    if (input && !input.value) input.value = normalized;
    if (changed) log('已捕获 Authorization', 'success');
  }

  function saveTimeoutMs(timeoutMs) {
    const n = Number(timeoutMs);
    if (!Number.isFinite(n) || n < 1000) return false;
    state.timeoutMs = n;
    localStorage.setItem(CONFIG.timeoutStorageKey, String(n));
    const input = document.querySelector('#sub2api-checker-timeout');
    if (input) input.value = String(Math.floor(n / 1000));
    return true;
  }

  function saveConcurrency(concurrency) {
    const n = clampConcurrency(concurrency);
    state.concurrency = n;
    localStorage.setItem(CONFIG.concurrencyStorageKey, String(n));
    const input = document.querySelector('#sub2api-checker-concurrency');
    if (input) input.value = String(n);
    return true;
  }

  function saveTestModel(model) {
    const normalized = String(model || '').trim();
    if (!normalized) return false;
    state.testModel = normalized;
    localStorage.setItem(CONFIG.testModelStorageKey, normalized);
    const input = document.querySelector('#sub2api-checker-test-model');
    if (input) input.value = normalized;
    return true;
  }

  function saveAutoDisable(enabled) {
    state.autoDisable = !!enabled;
    localStorage.setItem(CONFIG.autoDisableStorageKey, String(state.autoDisable));
    const input = document.querySelector('#sub2api-checker-auto-disable');
    if (input) input.checked = state.autoDisable;
    return true;
  }

  function normalizeGroup(value) {
    if (value === undefined || value === null) return '';
    const text = String(value).trim();
    if (!text) return '';
    if (['全部', '全部分组', 'all', 'null', 'undefined'].includes(text.toLowerCase())) return '';
    return text;
  }

  function getGroupFromUrl(urlLike = location.href) {
    try {
      const url = new URL(String(urlLike), location.origin);
      for (const name of CONFIG.groupParamNames) {
        const value = normalizeGroup(url.searchParams.get(name));
        if (value) return value;
      }
    } catch (_) {}
    return '';
  }

  function getElementMeta(el) {
    const parts = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      typeof el.className === 'string' ? el.className : '',
    ];

    if (el.labels) {
      parts.push(...Array.from(el.labels).map((label) => label.textContent || ''));
    }

    const closestLabel = el.closest('label')?.textContent || '';
    if (closestLabel) parts.push(closestLabel);

    const parentText = el.parentElement?.textContent || '';
    if (parentText.length < 120) parts.push(parentText);

    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  function looksLikeGroupControl(el) {
    const meta = getElementMeta(el);
    return meta.includes('group') || meta.includes('分组');
  }

  function getGroupFromDom() {
    const controls = Array.from(document.querySelectorAll('select,input')).filter(looksLikeGroupControl);

    for (const el of controls) {
      const value = normalizeGroup(
        el.tagName === 'SELECT'
          ? el.value || el.selectedOptions?.[0]?.value || el.selectedOptions?.[0]?.textContent || ''
          : el.value || el.getAttribute('value') || ''
      );
      if (value) return value;
    }

    const labelEls = Array.from(document.querySelectorAll('label,.ant-form-item-label,[class*="label"],[class*="Label"]'))
      .filter((el) => /分组|group/i.test(el.textContent || ''));

    for (const label of labelEls) {
      const container = label.closest('.ant-form-item') || label.parentElement;
      const candidates = [
        container?.querySelector('select')?.value,
        container?.querySelector('select')?.selectedOptions?.[0]?.value,
        container?.querySelector('select')?.selectedOptions?.[0]?.textContent,
        container?.querySelector('input')?.value,
        container?.querySelector('.ant-select-selection-item')?.getAttribute('title'),
        container?.querySelector('.ant-select-selection-item')?.textContent,
        container?.querySelector('[class*="singleValue"]')?.textContent,
        container?.querySelector('[class*="selected"]')?.textContent,
      ];

      for (const candidate of candidates) {
        const value = normalizeGroup(candidate);
        if (value) return value;
      }
    }

    return '';
  }

  function splitGroupCellText(text) {
    return String(text || '')
      .split(/\n|,|，|、/)
      .map((part) => normalizeGroup(part))
      .filter(Boolean)
      .filter((part) => !/^\+\d+$/.test(part) && part !== '-');
  }

  function findGroupColumnIndex(table) {
    const headerRows = Array.from(table.querySelectorAll('thead tr, tr')).slice(0, 3);
    for (const row of headerRows) {
      const cells = Array.from(row.children).filter((cell) => /^(TH|TD)$/i.test(cell.tagName));
      const index = cells.findIndex((cell) => /^(分组|groups?|account groups?)$/i.test((cell.textContent || '').trim()));
      if (index >= 0) return index;
    }
    return -1;
  }

  function getVisibleTableRows(table) {
    return Array.from(table.querySelectorAll('tbody tr'))
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && row.children.length > 1;
      });
  }

  function getGroupFromVisibleTableRows() {
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const groupColumnIndex = findGroupColumnIndex(table);
      if (groupColumnIndex < 0) continue;

      const values = new Set();
      for (const row of getVisibleTableRows(table)) {
        const cells = Array.from(row.children).filter((cell) => /^(TD|TH)$/i.test(cell.tagName));
        const cell = cells[groupColumnIndex];
        if (!cell) continue;
        for (const groupName of splitGroupCellText(cell.textContent)) {
          values.add(groupName);
        }
      }

      if (values.size === 1) return Array.from(values)[0];
      if (values.size > 1) {
        log(`当前可见账号包含多个分组：${Array.from(values).join(', ')}，请手动填写`, 'warn');
        return '';
      }
    }

    return '';
  }

  function readCurrentGroup() {
    return getGroupFromUrl(location.href) || getGroupFromDom() || getGroupFromVisibleTableRows();
  }

  function updateGroupDisplay() {
    const el = document.querySelector('#sub2api-checker-current-group');
    if (!el) return;
    el.textContent = state.currentGroup || '未识别';
    el.style.color = state.currentGroup ? '#95de64' : '#ffd666';
    const input = document.querySelector('#sub2api-checker-group');
    if (input && state.currentGroup && input.value !== state.currentGroup) input.value = state.currentGroup;
  }

  function saveCurrentGroup(group, source = '') {
    const normalized = normalizeGroup(group);
    if (!normalized) return false;

    const changed = state.currentGroup !== normalized;
    state.currentGroup = normalized;
    localStorage.setItem(CONFIG.currentGroupStorageKey, normalized);
    updateGroupDisplay();

    if (source && changed) {
      log(`已识别当前分组：${normalized}（${source}）`, 'success');
    }

    return true;
  }

  function readManualGroupInput() {
    return normalizeGroup(document.querySelector('#sub2api-checker-group')?.value || '');
  }

  function saveManualGroup() {
    const group = readManualGroupInput();
    if (!group) {
      log('手动分组不能为空', 'error');
      return false;
    }
    return saveCurrentGroup(group, '手动输入');
  }

  async function injectAuthSniffer() {
    while (!document.documentElement) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const script = document.createElement('script');
    const nonce = document.querySelector('script[nonce]')?.nonce || document.querySelector('script[nonce]')?.getAttribute('nonce');
    if (nonce) script.nonce = nonce;
    script.textContent = `
      (() => {
        const groupParamNames = ${JSON.stringify(CONFIG.groupParamNames)};

        const emit = (auth) => {
          if (!auth) return;
          document.dispatchEvent(new CustomEvent('__sub2api_checker_auth__', { detail: auth }));
        };

        const emitGroup = (urlLike) => {
          try {
            if (!urlLike) return;
            const url = new URL(String(urlLike), location.origin);
            if (!url.pathname.includes('/api/v1/admin/accounts')) return;

            for (const name of groupParamNames) {
              const value = (url.searchParams.get(name) || '').trim();
              if (value) {
                document.dispatchEvent(new CustomEvent('__sub2api_checker_group__', { detail: value }));
                return;
              }
            }
          } catch (_) {}
        };

        const pickAuth = (headersLike) => {
          try {
            if (!headersLike) return '';
            if (headersLike instanceof Headers) {
              return headersLike.get('Authorization') || headersLike.get('authorization') || '';
            }
            if (Array.isArray(headersLike)) {
              for (const [k, v] of headersLike) {
                if (String(k).toLowerCase() === 'authorization') return v || '';
              }
              return '';
            }
            if (typeof headersLike === 'object') {
              for (const key of Object.keys(headersLike)) {
                if (key.toLowerCase() === 'authorization') return headersLike[key] || '';
              }
            }
          } catch (_) {}
          return '';
        };

        const origFetch = window.fetch;
        if (origFetch) {
          window.fetch = function(input, init) {
            const auth =
              pickAuth(init && init.headers) ||
              pickAuth(input && input.headers);
            if (auth) emit(auth);

            const requestUrl =
              typeof input === 'string' || input instanceof URL
                ? String(input)
                : input && input.url;
            emitGroup(requestUrl);

            return origFetch.apply(this, arguments);
          };
        }

        const origOpen = XMLHttpRequest.prototype.open;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function() {
          this.__sub2apiAuth = '';
          emitGroup(arguments[1]);
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          if (String(name).toLowerCase() === 'authorization' && value) {
            this.__sub2apiAuth = value;
            emit(value);
          }
          return origSetHeader.apply(this, arguments);
        };
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    document.addEventListener('__sub2api_checker_auth__', (event) => {
      saveAuth(event.detail);
    });

    document.addEventListener('__sub2api_checker_group__', (event) => {
      saveCurrentGroup(event.detail, '账号列表请求');
    });
  }

  function updateStats() {
    const el = document.querySelector('#sub2api-checker-stats');
    if (!el) return;
    const s = state.stats;
    const queued = Math.max(0, s.total - s.checked - s.active);
    el.textContent = `总数 ${s.total} | 运行中 ${s.active} | 队列 ${queued} | 已处理 ${s.checked} | 正常 ${s.ok} | 已启用 ${s.enabled} | 已关闭 ${s.disabled} | 跳过 ${s.skipped} | 异常 ${s.failed}`;
  }

  function updatePanelCollapsed() {
    const shell = document.querySelector('#sub2api-checker-shell');
    const root = document.querySelector('#sub2api-checker-panel');
    const toggle = document.querySelector('#sub2api-checker-toggle');
    if (!root || !toggle || !shell) return;
    root.style.width = state.collapsed ? '0px' : '420px';
    root.style.opacity = state.collapsed ? '0' : '1';
    root.style.marginRight = state.collapsed ? '0px' : '12px';
    root.style.pointerEvents = state.collapsed ? 'none' : 'auto';
    root.style.transform = state.collapsed ? 'translateX(12px)' : 'translateX(0)';
    toggle.textContent = state.collapsed ? '账号巡检' : '收起';
    toggle.style.borderRadius = state.collapsed ? '10px 0 0 10px' : '10px';
    shell.style.pointerEvents = 'auto';
  }

  function ensurePanel() {
    if (state.panelReady) return;
    state.panelReady = true;

    const shell = document.createElement('div');
    shell.id = 'sub2api-checker-shell';
    shell.style.cssText = `
      position: fixed;
      right: 0;
      top: 120px;
      z-index: 1000000;
      display: flex;
      flex-direction: row;
      align-items: flex-start;
      pointer-events: auto;
    `;
    document.body.appendChild(shell);

    const toggle = document.createElement('button');
    toggle.id = 'sub2api-checker-toggle';
    toggle.style.cssText = `
      padding: 10px 8px;
      border: 0;
      border-radius: 10px 0 0 10px;
      background: #1677ff;
      color: #fff;
      cursor: pointer;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      box-shadow: 0 8px 24px rgba(0,0,0,.25);
      transition: transform .28s ease, box-shadow .28s ease, border-radius .28s ease;
      font: 12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,PingFang SC,Microsoft YaHei,sans-serif;
    `;
    toggle.addEventListener('mouseenter', () => {
      toggle.style.transform = 'translateX(-2px)';
      toggle.style.boxShadow = '0 10px 28px rgba(0,0,0,.32)';
    });
    toggle.addEventListener('mouseleave', () => {
      toggle.style.transform = 'translateX(0)';
      toggle.style.boxShadow = '0 8px 24px rgba(0,0,0,.25)';
    });
    toggle.addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      updatePanelCollapsed();
    });
    shell.appendChild(toggle);

    const root = document.createElement('div');
    root.id = 'sub2api-checker-panel';
    root.style.cssText = `
      width: 0;
      opacity: 0;
      overflow: hidden;
      transition: width .28s ease, opacity .22s ease, margin-right .28s ease, transform .28s ease;
      transform: translateX(12px);
    `;
    root.innerHTML = `
      <div id="sub2api-checker-panel-inner" style="
        width:420px;
        background:rgba(16, 18, 27, 0.96);
        color:#fff;
        border:1px solid #30363d;
        border-radius:12px;
        box-shadow:0 8px 24px rgba(0,0,0,.35);
        font:12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,PingFang SC,Microsoft YaHei,sans-serif;
        overflow:hidden;
      ">
      <div style="padding:12px 14px;border-bottom:1px solid #30363d;font-weight:700;">Sub2API 账号模型巡检</div>
      <div style="padding:12px 14px;display:flex;flex-direction:column;gap:8px;">
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>Authorization（优先自动捕获，抓不到再手填）</span>
          <input id="sub2api-checker-auth" type="text" placeholder="Bearer xxxxxx"
            style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #434a57;background:#111723;color:#fff;" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>测活分组（可手动填写，自动识别会回填）</span>
          <input id="sub2api-checker-group" type="text" placeholder="例如：codex"
            style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #434a57;background:#111723;color:#fff;" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>单模型超时时间（秒）</span>
          <input id="sub2api-checker-timeout" type="number" min="1" step="1" placeholder="45"
            style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #434a57;background:#111723;color:#fff;" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>账号并发数（1-${CONFIG.maxConcurrency}，建议 5-15）</span>
          <input id="sub2api-checker-concurrency" type="number" min="1" max="${CONFIG.maxConcurrency}" step="1" placeholder="8"
            style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #434a57;background:#111723;color:#fff;" />
        </label>
        <label style="display:flex;flex-direction:column;gap:4px;">
          <span>测试模型</span>
          <input id="sub2api-checker-test-model" type="text" placeholder="gpt-5.4"
            style="width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid #434a57;background:#111723;color:#fff;" />
        </label>
        <label style="display:flex;gap:8px;align-items:center;color:#d9d9d9;">
          <input id="sub2api-checker-auto-disable" type="checkbox" style="margin:0;" />
          <span>模型异常时自动关闭账号调度</span>
        </label>
        <div style="display:flex;gap:8px;align-items:center;color:#bfbfbf;">
          <span>当前页面分组：</span>
          <strong id="sub2api-checker-current-group" style="flex:1;color:#ffd666;">未识别</strong>
          <button id="sub2api-checker-refresh-group" style="padding:6px 8px;border:0;border-radius:8px;background:#434a57;color:#fff;cursor:pointer;">重新读取</button>
          <button id="sub2api-checker-save-group" style="padding:6px 8px;border:0;border-radius:8px;background:#434a57;color:#fff;cursor:pointer;">保存分组</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button id="sub2api-checker-start" style="flex:1;padding:8px 10px;border:0;border-radius:8px;background:#1677ff;color:#fff;cursor:pointer;">开始巡检</button>
          <button id="sub2api-checker-stop" style="flex:1;padding:8px 10px;border:0;border-radius:8px;background:#fa541c;color:#fff;cursor:pointer;">停止</button>
        </div>
        <div id="sub2api-checker-stats" style="color:#bfbfbf;">总数 0 | 运行中 0 | 队列 0 | 已处理 0 | 正常 0 | 已启用 0 | 已关闭 0 | 跳过 0 | 异常 0</div>
        <div id="sub2api-checker-log" style="height:320px;overflow:auto;background:#0b0f17;border:1px solid #30363d;border-radius:8px;padding:8px;"></div>
      </div>
      </div>
    `;
    shell.appendChild(root);

    const authInput = root.querySelector('#sub2api-checker-auth');
    authInput.value = state.authHeader;
    authInput.addEventListener('change', () => {
      const v = authInput.value.trim();
      if (v) saveAuth(v);
    });

    const groupInput = root.querySelector('#sub2api-checker-group');
    groupInput.value = state.currentGroup || normalizeGroup(localStorage.getItem(CONFIG.currentGroupStorageKey));
    groupInput.addEventListener('change', saveManualGroup);

    const timeoutInput = root.querySelector('#sub2api-checker-timeout');
    timeoutInput.value = String(Math.floor(state.timeoutMs / 1000));
    timeoutInput.addEventListener('change', () => {
      const sec = Number(timeoutInput.value || 0);
      if (!saveTimeoutMs(sec * 1000)) {
        timeoutInput.value = String(Math.floor(state.timeoutMs / 1000));
        log('超时时间无效，需大于等于 1 秒', 'error');
        return;
      }
      log(`已设置单模型超时 ${sec} 秒`, 'success');
    });

    const concurrencyInput = root.querySelector('#sub2api-checker-concurrency');
    concurrencyInput.value = String(state.concurrency);
    concurrencyInput.addEventListener('change', () => {
      saveConcurrency(concurrencyInput.value || CONFIG.defaultConcurrency);
      log(`已设置账号并发数 ${state.concurrency}`, 'success');
    });

    const testModelInput = root.querySelector('#sub2api-checker-test-model');
    testModelInput.value = state.testModel;
    testModelInput.addEventListener('change', () => {
      const model = testModelInput.value.trim();
      if (!saveTestModel(model)) {
        testModelInput.value = state.testModel;
        log('测试模型不能为空', 'error');
        return;
      }
      log(`已设置测试模型 ${state.testModel}`, 'success');
    });

    const autoDisableInput = root.querySelector('#sub2api-checker-auto-disable');
    autoDisableInput.checked = state.autoDisable;
    autoDisableInput.addEventListener('change', () => {
      saveAutoDisable(autoDisableInput.checked);
      log(`模型异常时${state.autoDisable ? '会' : '不会'}自动关闭账号调度`, 'success');
    });

    root.querySelector('#sub2api-checker-refresh-group').addEventListener('click', () => {
      const group = readCurrentGroup();
      if (group) {
        saveCurrentGroup(group, '当前页面');
      } else {
        updateGroupDisplay();
        log('未能从当前页面识别分组，开始时会弹窗确认', 'warn');
      }
    });
    root.querySelector('#sub2api-checker-save-group').addEventListener('click', saveManualGroup);

    root.querySelector('#sub2api-checker-start').addEventListener('click', () => run().catch((err) => {
      log(`运行异常：${err.message}`, 'error');
      state.running = false;
    }));
    root.querySelector('#sub2api-checker-stop').addEventListener('click', () => {
      state.stopRequested = true;
      log('已请求停止，当前请求结束后退出', 'warn');
    });

    updateGroupDisplay();
    updatePanelCollapsed();
  }

  async function waitDomReady() {
    if (document.body) return;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.authHeader && !headers.has('Authorization')) {
      headers.set('Authorization', state.authHeader);
    }
    const resp = await fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });
    return resp;
  }

  async function parseErrorResponse(resp) {
    try {
      const text = await resp.text();
      if (!text) return '';
      return text.slice(0, 500);
    } catch (_) {
      return '';
    }
  }

  function normalizeGroupNameKey(group) {
    return normalizeGroup(group).toLowerCase();
  }

  async function resolveGroupFilterValue(group) {
    const normalized = normalizeGroup(group);
    if (!normalized) return '';
    if (normalized === 'ungrouped' || /^\d+$/.test(normalized)) return normalized;

    const cacheKey = normalizeGroupNameKey(normalized);
    if (groupIDCache.has(cacheKey)) return groupIDCache.get(cacheKey);

    const resp = await apiFetch(`${CONFIG.apiBase}/api/v1/admin/groups/all`, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!resp.ok) {
      const detail = await parseErrorResponse(resp);
      throw new Error(`分组列表请求失败：HTTP ${resp.status}${detail ? `，${detail}` : ''}`);
    }

    const json = await resp.json();
    if (json.code !== 0) {
      throw new Error(`分组列表返回异常：${json.message || json.code}`);
    }

    const groups = Array.isArray(json.data) ? json.data : [];
    for (const item of groups) {
      const nameKey = normalizeGroupNameKey(item?.name);
      const id = item?.id;
      if (!nameKey || id === undefined || id === null) continue;
      groupIDCache.set(nameKey, String(id));
    }

    const resolved = groupIDCache.get(cacheKey);
    if (!resolved) {
      throw new Error(`没有找到名为 ${normalized} 的分组，请填写分组 ID 或确认分组名称`);
    }

    return resolved;
  }

  async function fetchAccounts() {
    const groupFilter = await resolveGroupFilterValue(state.currentGroup);
    if (groupFilter !== state.currentGroup) {
      log(`分组 ${state.currentGroup} 已解析为 ID ${groupFilter}`, 'success');
    }

    let page = 1;
    const items = [];
    while (true) {
      const url = new URL('/api/v1/admin/accounts', CONFIG.apiBase);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(CONFIG.pageSize));
      url.searchParams.set('platform', '');
      url.searchParams.set('type', '');
      url.searchParams.set('status', '');
      url.searchParams.set('privacy_mode', '');
      url.searchParams.set('group', groupFilter);
      url.searchParams.set('search', '');
      url.searchParams.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');

      const resp = await apiFetch(url.toString(), {
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!resp.ok) {
        const detail = await parseErrorResponse(resp);
        throw new Error(`账号列表请求失败：HTTP ${resp.status}${detail ? `，${detail}` : ''}`);
      }
      const json = await resp.json();
      if (json.code !== 0) throw new Error(`账号列表返回异常：${json.message || json.code}`);

      const pageItems = json?.data?.items || [];
      items.push(...pageItems);

      const pages = Number(json?.data?.pages || 1);
      if (page >= pages || pageItems.length === 0) break;
      page += 1;
    }
    return items;
  }

  function getModels(account) {
    const targetModel = String(state.testModel || '').trim();
    if (targetModel) return [targetModel];

    const mapping = account?.credentials?.model_mapping || {};
    const keys = Object.keys(mapping).filter(Boolean);
    if (keys.length <= 1) return keys;

    const preferred = [];
    for (const model of CONFIG.preferredModels) {
      if (keys.includes(model)) preferred.push(model);
    }
    const rest = keys.filter((k) => !preferred.includes(k)).sort();
    return [...preferred, ...rest];
  }

  async function testModel(accountId, modelId) {
    const controller = new AbortController();
    let timer = null;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new Error(`模型 ${modelId} 流式超时`)), state.timeoutMs);
    };

    try {
      resetTimer();
      const resp = await apiFetch(`${CONFIG.apiBase}/api/v1/admin/accounts/${accountId}/test`, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model_id: modelId, prompt: CONFIG.prompt }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        clearTimeout(timer);
        return { ok: false, reason: `HTTP ${resp.status}` };
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        clearTimeout(timer);
        const text = await resp.text();
        return { ok: false, reason: `无响应流：${text.slice(0, 200)}` };
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        resetTimer();
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

        let splitIndex;
        while ((splitIndex = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          const dataLines = chunk
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());

          for (const line of dataLines) {
            if (!line) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch (_) {
              continue;
            }
            if (event.type === 'error') {
              clearTimeout(timer);
              return { ok: false, reason: event.error || '未知错误' };
            }
            if (event.type === 'test_complete') {
              clearTimeout(timer);
              return { ok: !!event.success, reason: event.success ? 'success' : 'test_complete=false' };
            }
          }
        }
      }

      clearTimeout(timer);
      return { ok: false, reason: '响应流结束但没有 test_complete' };
    } catch (err) {
      clearTimeout(timer);
      return {
        ok: false,
        reason: err?.name === 'AbortError' ? '请求超时' : (err?.message || String(err)),
      };
    }
  }

  async function setAccountSchedulable(accountId, schedulable) {
    const resp = await apiFetch(`${CONFIG.apiBase}/api/v1/admin/accounts/${accountId}/schedulable`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ schedulable: !!schedulable }),
    });

    if (!resp.ok) {
      return { ok: false, reason: `HTTP ${resp.status}` };
    }
    const json = await resp.json();
    if (json.code !== 0) {
      return { ok: false, reason: json.message || `code=${json.code}` };
    }
    return { ok: true, data: json.data };
  }

  function resetStats() {
    state.stats = {
      total: 0,
      checked: 0,
      active: 0,
      started: 0,
      ok: 0,
      enabled: 0,
      disabled: 0,
      skipped: 0,
      failed: 0,
    };
    updateStats();
    const logBox = document.querySelector('#sub2api-checker-log');
    if (logBox) logBox.innerHTML = '';
  }

  async function ensureAuth() {
    const cached = getCachedAuthToken();
    if (cached) {
      saveAuth(cached);
      return true;
    }
    if (state.authHeader) return true;
    const fromInput = document.querySelector('#sub2api-checker-auth')?.value?.trim();
    if (fromInput) {
      saveAuth(fromInput);
      return true;
    }
    const manual = prompt('没有自动捕获到 Authorization，请粘贴 Bearer token');
    if (!manual) return false;
    saveAuth(manual.trim());
    return true;
  }

  async function ensureGroup() {
    const fromInput = readManualGroupInput();
    if (fromInput) {
      return saveCurrentGroup(fromInput, '手动输入');
    }

    const detected = readCurrentGroup();
    if (detected) {
      return saveCurrentGroup(detected, '当前页面');
    }

    if (state.currentGroup) return true;

    const lastGroup = normalizeGroup(localStorage.getItem(CONFIG.currentGroupStorageKey));
    const manual = prompt(
      `没有识别到当前页面选择的分组，请填写本次测活分组。${lastGroup ? `\n上次识别到：${lastGroup}` : ''}`,
      lastGroup || ''
    );

    if (!manual) return false;
    return saveCurrentGroup(manual.trim(), '手动确认');
  }

  async function processAccount(account) {
    const title = `#${account.id} ${account.name || '(未命名)'}`;

    try {
      if (CONFIG.onlyCheckSchedulable && !account.schedulable) {
        state.stats.skipped += 1;
        log(`${title} 已去掉调度，跳过测试`, 'warn');
        return;
      }

      const models = getModels(account);
      if (!models.length) {
        state.stats.failed += 1;
        if (!state.autoDisable) {
          log(`${title} 没有 model_mapping，但未关闭 schedulable`, 'warn');
          return;
        }

        log(`${title} 没有 model_mapping，准备关闭`, 'error');
        const off = await setAccountSchedulable(account.id, false);
        if (off.ok) {
          state.stats.disabled += 1;
          log(`${title} 已关闭 schedulable`, 'success');
        } else {
          log(`${title} 关闭失败：${off.reason}`, 'error');
        }
        return;
      }

      log(`${title} 开始测试 ${models.length} 个模型`);
      let accountOk = true;
      let failReason = '';
      let testedCount = 0;

      for (const model of models) {
        if (state.stopRequested) break;
        log(`${title} 测试模型 ${model}`);
        const result = await testModel(account.id, model);
        testedCount += 1;
        if (!result.ok) {
          accountOk = false;
          failReason = `模型 ${model} 异常：${result.reason}`;
          log(`${title} ${failReason}`, 'error');
          if (CONFIG.stopOnFirstModelFailure) break;
        } else {
          log(`${title} 模型 ${model} 正常`, 'success');
        }
      }

      if (state.stopRequested && testedCount < models.length && accountOk) {
        state.stats.skipped += 1;
        log(`${title} 因停止请求未完成全部模型测试，未改动 schedulable`, 'warn');
        return;
      }

      if (accountOk) {
        state.stats.ok += 1;
        if (!account.schedulable) {
          const on = await setAccountSchedulable(account.id, true);
          if (on.ok) {
            state.stats.enabled += 1;
            log(`${title} 全部模型正常，已重新启用 schedulable`, 'success');
          } else {
            log(`${title} 模型正常但重新启用失败：${on.reason}`, 'error');
          }
        } else {
          log(`${title} 全部模型正常`, 'success');
        }
      } else {
        state.stats.failed += 1;
        if (!state.autoDisable) {
          log(`${title} 检测到异常但未关闭 schedulable（原因：${failReason}）`, 'warn');
          return;
        }

        const off = await setAccountSchedulable(account.id, false);
        if (off.ok) {
          state.stats.disabled += 1;
          log(`${title} 已关闭 schedulable（原因：${failReason}）`, 'success');
        } else {
          log(`${title} 关闭失败：${off.reason}`, 'error');
        }
      }
    } finally {
      state.stats.checked += 1;
      updateStats();
    }
  }

  async function runWorkerPool(accounts) {
    const concurrency = clampConcurrency(state.concurrency);
    log(`账号级并发 ${concurrency}，单账号内模型按顺序测试`);

    async function worker(workerIndex) {
      while (!state.stopRequested) {
        const index = state.stats.started;
        if (index >= accounts.length) break;

        state.stats.started += 1;
        state.stats.active += 1;
        updateStats();

        try {
          await processAccount(accounts[index]);
        } catch (err) {
          state.stats.failed += 1;
          state.stats.checked += 1;
          log(`工作线程 ${workerIndex} 处理账号异常：${err?.message || String(err)}`, 'error');
          updateStats();
        } finally {
          state.stats.active -= 1;
          updateStats();
        }
      }
    }

    const workerCount = Math.min(concurrency, accounts.length);
    await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
  }

  async function run() {
    if (state.running) {
      log('已有任务在运行', 'warn');
      return;
    }
    if (!(await ensureAuth())) {
      log('缺少 Authorization，已取消', 'error');
      return;
    }
    if (!(await ensureGroup())) {
      log('缺少测活分组，已取消', 'error');
      return;
    }

    state.running = true;
    state.stopRequested = false;
    resetStats();

    try {
      state.collapsed = false;
      updatePanelCollapsed();
      log(`开始拉取账号列表（分组：${state.currentGroup}）`);
      const accounts = await fetchAccounts();
      state.stats.total = accounts.length;
      updateStats();
      log(`共获取 ${accounts.length} 个账号`, 'success');

      await runWorkerPool(accounts);

      if (state.stopRequested) {
        log('任务已按要求停止', 'warn');
      } else {
        log('巡检完成', 'success');
      }
    } finally {
      state.running = false;
      state.stats.active = 0;
      updateStats();
    }
  }

  injectAuthSniffer();
  waitDomReady().then(() => {
    ensurePanel();

    const group = readCurrentGroup();
    if (group) saveCurrentGroup(group, '当前页面');

    if (state.authHeader) {
      log('脚本已就绪，已从本地缓存 auth_token 读取 Authorization', 'success');
    } else {
      log('脚本已就绪，未发现 auth_token；可刷新页面自动捕获或手动粘贴');
    }
  });
})();
