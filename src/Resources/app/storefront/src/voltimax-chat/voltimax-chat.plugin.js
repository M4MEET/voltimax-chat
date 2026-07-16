import Plugin from 'src/plugin-system/plugin.class';
import HttpClient from 'src/service/http-client.service';

export default class VoltimaxChatPlugin extends Plugin {
    static options = {
        configUrl:  '',
        consentUrl: '',
        verifyUrl:  '',
    };

    init() {
        this.httpClient      = new HttpClient();
        this.state           = 'CLOSED';
        this._minimized      = false;
        this._expanded       = false;
        this.config          = null;
        this.token           = null;
        this.customerContext = null;
        this.ws              = null;
        this.sse             = null;
        this._earlySse       = null;
        this.topics          = null;
        this.currentTopic    = null;
        this._bubbleEl       = null;
        this._pendingTopic   = null;
        this._chatId         = null;
        this._sessionId      = null;
        this._unreadCount    = 0;
        this._history        = [];   // structured transcript for safe session restore
        this._restoring      = false;
        this._streamingRow   = null;
        this._streamingRaw   = '';
        this._typingEl          = null;
        this._currentTopicId    = null;
        this._reconnectAttempts = 0;
        this._reconnectTimer    = null;
        this._pendingSubCards   = null;
        this._pendingFreeText   = null;
        this._expandedTopicId   = null;
        this._sessionClosed     = false;
        this._resumeRequested   = false;
        this._inputLocked       = false;
        // Cross-tab: unique id per tab; _yielded = another tab owns the socket
        this._tabId             = Math.random().toString(36).slice(2) + Date.now().toString(36);
        this._yielded           = false;

        // Cross-tab coordination: 'storage' fires in OTHER tabs only, which is
        // exactly the takeover/mirror signal we need.
        window.addEventListener('storage', (e) => this._onStorageEvent(e));
        // visibilitychange covers tab switches; 'focus' covers the case where
        // the owning window closes and this one is already visible.
        const reclaimIfYielded = () => {
            if (document.visibilityState === 'visible'
                && this._yielded && this.state === 'CHATTING') {
                this._resumeHere();
            }
        };
        document.addEventListener('visibilitychange', reclaimIfYielded);
        window.addEventListener('focus', reclaimIfYielded);

        // Save session before page navigation so chat survives
        window.addEventListener('beforeunload', () => {
            if (this.state === 'CHATTING' && this._sessionId) {
                this._saveSession();
            }
        });

        // Shopware uses AJAX navigation — also save on popstate and click
        window.addEventListener('popstate', () => {
            if (this.state === 'CHATTING' && this._sessionId) {
                this._saveSession();
            }
        });
        document.addEventListener('click', (e) => {
            var link = e.target.closest('a[href]');
            if (link && link.hostname === window.location.hostname && !link.target && this.state === 'CHATTING' && this._sessionId) {
                this._saveSession();
            }
        }, true);

        this._loadConfig();
    }

    // ── Session Persistence ──────────────────────────────────────────────────
    // The session lives in localStorage so the conversation follows the
    // customer into new tabs (product links open _blank). Cross-tab socket
    // ownership is handled in the "connection ownership" section below.

    _saveSession() {
        // A yielded tab mirrors the owner's transcript — it must never write
        // the shared session (its copy may lag and would clobber newer history,
        // e.g. via the beforeunload save when the tab is closed).
        if (this._yielded) return;
        try {
            var data = {
                chatId: this._chatId,
                sessionId: this._sessionId,
                state: this.state,
                topic: this.currentTopic || this._currentTopicId,
                token: this.token,
                config: this.config,
                customerContext: this.customerContext,
                minimized: !!this._minimized,
                ts: Date.now(),
                // Structured items re-rendered through the safe builders on
                // restore — innerHTML is never persisted (stored-XSS surface).
                history: (this._history || []).slice(-60),
            };
            localStorage.setItem('voltimax_chat_session', JSON.stringify(data));
        } catch (e) { /* silent */ }
    }

    _restoreSession() {
        try {
            var raw = localStorage.getItem('voltimax_chat_session');
            if (!raw) {
                // Migrate a session saved by a pre-2.8 widget mid-deploy
                raw = sessionStorage.getItem('voltimax_chat_session');
                if (raw) {
                    try {
                        localStorage.setItem('voltimax_chat_session', raw);
                        sessionStorage.removeItem('voltimax_chat_session');
                    } catch (e) { /* silent */ }
                }
            }
            if (!raw) return false;
            var data = JSON.parse(raw);
            if (!data.sessionId || !data.token || !data.config) return false;
            if (data.messages && !data.history) {
                // Legacy innerHTML-format session from an older widget — drop it.
                this._clearSession();
                return false;
            }
            if (data.ts && Date.now() - data.ts > 24 * 3600 * 1000) {
                // Stale conversation (localStorage outlives the browser session)
                this._clearSession();
                return false;
            }

            this._chatId = data.chatId;
            this._sessionId = data.sessionId;
            this.token = data.token;
            this.config = data.config;
            this.customerContext = data.customerContext;
            this.currentTopic = data.topic;
            this._currentTopicId = data.topic;

            // Rebuild the chat UI
            this._renderWidget();
            this._buildChatUI(data.topic || 'general');

            // Restore messages from structured history — re-rendered through
            // the safe builders, never by re-injecting stored HTML.
            this._replayHistory(data.history);

            this.state = 'CHATTING';

            if (data.minimized) {
                // The customer had collapsed the chat — restore to the bubble,
                // not a surprise-open window on every new tab. The bubble
                // itself is rendered by _loadConfig after we return; it keys
                // its visibility off this._minimized.
                this._minimized = true;
                var widget = document.querySelector('.voltimax-chat-widget');
                if (widget) widget.style.display = 'none';
            }

            if (document.visibilityState === 'visible') {
                this._connectToServerB(data.topic || 'general');
            } else {
                // Background tab (cmd+click) — don't steal the socket from the
                // tab the customer is still reading. Claimed on visibility.
                this._yielded = true;
                this._showHandoffNotice();
            }

            return true;
        } catch (e) {
            return false;
        }
    }

    // Replay structured history into the messages container (clears it first).
    // Used by initial restore and by cross-tab mirroring/takeover.
    _replayHistory(history) {
        var messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages || !history || !history.length) return;
        messages.textContent = '';
        var self = this;
        this._restoring = true;
        history.forEach(function(item) {
            try {
                if (item.kind === 'user' || item.kind === 'ai') {
                    self._addMessage(item.kind, item.text || '');
                } else if (item.kind === 'ai_card') {
                    if (item.text) self._addMessage('ai', item.text);
                    if (item.card) self._renderInfoCard(item.card);
                } else if (item.kind === 'card' && item.card) {
                    self._renderInfoCard(item.card);
                }
            } catch (e) { /* skip unrenderable item */ }
        });
        this._restoring = false;
        this._history = history.slice(-60);
        messages.scrollTop = messages.scrollHeight;
    }

    _clearSession() {
        this._history = [];
        try {
            localStorage.removeItem('voltimax_chat_session');
            localStorage.removeItem('voltimax_chat_owner');
            sessionStorage.removeItem('voltimax_chat_session');
        } catch (e) { /* silent */ }
    }

    // ── Cross-tab connection ownership ────────────────────────────────────────
    // Exactly one tab holds the WebSocket: the last one the customer looked
    // at. Claims go through localStorage; the 'storage' event tells the
    // previous owner to yield. A yielded tab mirrors the shared transcript
    // and reclaims automatically when it becomes visible again.

    _claimConnection() {
        this._yielded = false;
        try {
            localStorage.setItem('voltimax_chat_owner',
                JSON.stringify({ tab: this._tabId, ts: Date.now() }));
        } catch (e) { /* silent */ }
    }

    _onStorageEvent(e) {
        if (e.key === 'voltimax_chat_owner' && e.newValue) {
            try {
                if (JSON.parse(e.newValue).tab !== this._tabId) this._yieldConnection();
            } catch (err) { /* silent */ }
        } else if (e.key === 'voltimax_chat_session') {
            if (!e.newValue && this.state === 'CHATTING') {
                // Chat was closed in another tab — tear down here too.
                // Null the session first so /chat/end isn't posted twice.
                this._sessionId = null;
                this._doClose();
            } else if (e.newValue && this._yielded && this.state === 'CHATTING') {
                // Live-mirror the conversation the owning tab is having.
                // Replay clears the container, so re-mount the handoff notice.
                try {
                    this._replayHistory(JSON.parse(e.newValue).history);
                    this._showHandoffNotice();
                } catch (err) { /* silent */ }
            }
        }
    }

    _yieldConnection() {
        if (this._yielded || this.state !== 'CHATTING') return;
        this._yielded = true;
        clearTimeout(this._reconnectTimer);
        this._reconnectAttempts = 0;
        if (this.ws)  { try { this.ws.onclose = null; this.ws.close(); } catch (e) {} this.ws = null; }
        if (this.sse) { try { this.sse.close(); } catch (e) {} this.sse = null; }
        this._setConnectionStatus('disconnected');
        this._showHandoffNotice();
    }

    _resumeHere() {
        this._yielded = false;
        this._hideHandoffNotice();
        // The other tab may have continued the conversation — sync first
        try {
            var raw = localStorage.getItem('voltimax_chat_session');
            if (raw) {
                var data = JSON.parse(raw);
                if ((data.history || []).length !== (this._history || []).length) {
                    this._replayHistory(data.history);
                }
            }
        } catch (e) { /* silent */ }
        this._reconnectAttempts = 0;
        this._connectToServerB(this._currentTopicId || this.currentTopic || 'general');
    }

    _showHandoffNotice() {
        if (document.querySelector('.voltimax-chat-handoff')) return;
        var messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;
        var banner = document.createElement('div');
        banner.className = 'voltimax-chat-handoff';
        banner.setAttribute('role', 'status');
        var txt = document.createElement('span');
        txt.textContent = 'Der Chat läuft gerade in einem anderen Tab.';
        banner.appendChild(txt);
        var self = this;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Hier fortsetzen';
        btn.addEventListener('click', function() { self._resumeHere(); });
        banner.appendChild(btn);
        messages.appendChild(banner);
        messages.scrollTop = messages.scrollHeight;
        var input = this._chatInputEl();
        if (input) { input.disabled = true; input.placeholder = 'Chat in anderem Tab aktiv'; }
    }

    _hideHandoffNotice() {
        var banner = document.querySelector('.voltimax-chat-handoff');
        if (banner) banner.remove();
        var input = this._chatInputEl();
        if (input && !this._inputLocked) { input.disabled = false; input.placeholder = 'Schreib eine Nachricht …'; }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * Only allow http(s) and same-origin relative URLs in href attributes.
     * Server-/AI-supplied card links must never inject javascript:/data: URIs.
     */
    _safeUrl(url) {
        if (typeof url !== 'string' || url === '') return '#';
        var trimmed = url.trim();
        if (/^https?:\/\//i.test(trimmed)) return trimmed;
        if (trimmed.charAt(0) === '/' && trimmed.charAt(1) !== '/') return trimmed;
        return '#';
    }


    _buildAvatarEl() {
        // Professional monogram tile (no mascot imagery).
        var el = document.createElement('div');
        el.className = 'voltimax-chat-ai-row__avatar';
        el.innerHTML = '<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:6px;background:var(--vtx-primary, #d99a4e);color:#231a10;font-family:Georgia, \'Times New Roman\', serif;font-weight:700;font-size:11px;line-height:1">G</span>';
        return el;
    }

    _shiftColor(hex, amount) {
        // Lighten and shift a hex color for gradient effects
        var r = parseInt(hex.slice(1, 3), 16);
        var g = parseInt(hex.slice(3, 5), 16);
        var b = parseInt(hex.slice(5, 7), 16);
        r = Math.min(255, r + amount);
        g = Math.min(255, g + amount / 2);
        b = Math.min(255, b + amount * 1.5);
        return '#' + [r, g, b].map(function(v) { return Math.round(v).toString(16).padStart(2, '0'); }).join('');
    }

    _generateChatId() {
        const bytes = new Uint8Array(4);
        (window.crypto || window.msCrypto).getRandomValues(bytes);
        return '#' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    }


    // Mark the last user message as read: double check + 'Gelesen'
    _markLastUserRead() {
        const el = this._lastUserStatusEl;
        if (!el) return;
        el.classList.add('is-read');
        const label = el.querySelector('.vtx-status-label');
        if (label) label.textContent = 'Gelesen';
    }

    // ── Verification progress indicator ──────────────────────────────────────
    // Shown while the server checks an order/ticket lookup; flips to a green
    // success state when the resulting card arrives.
    _showVerifyingCard(text) {
        this._resolveVerifyingCard(false);
        var messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;
        var el = document.createElement('div');
        el.className = 'vtx-verifying-card';
        var row = document.createElement('div');
        row.className = 'vtx-verifying-card__row';
        var spinner = document.createElement('span');
        spinner.className = 'vtx-verifying-card__spinner';
        var label = document.createElement('span');
        label.className = 'vtx-verifying-card__text';
        label.textContent = text;
        row.appendChild(spinner);
        row.appendChild(label);
        el.appendChild(row);
        var track = document.createElement('div');
        track.className = 'vtx-verifying-card__track';
        var bar = document.createElement('div');
        bar.className = 'vtx-verifying-card__bar';
        track.appendChild(bar);
        el.appendChild(track);
        messages.appendChild(el);
        messages.scrollTop = messages.scrollHeight;
        this._verifyingEl = el;
    }

    _resolveVerifyingCard(success) {
        var el = this._verifyingEl;
        if (!el) return;
        this._verifyingEl = null;
        if (!success) { el.remove(); return; }
        el.classList.add('is-success');
        el.textContent = '';
        var row = document.createElement('div');
        row.className = 'vtx-verifying-card__row';
        var check = document.createElement('span');
        check.className = 'vtx-verifying-card__check';
        check.textContent = '\u2713';
        var label = document.createElement('span');
        label.className = 'vtx-verifying-card__text';
        label.textContent = 'Erfolgreich verifiziert';
        row.appendChild(check);
        row.appendChild(label);
        el.appendChild(row);
        setTimeout(function() {
            el.classList.add('is-leaving');
            setTimeout(function() { el.remove(); }, 350);
        }, 1200);
    }

    _formatTime(date) {
        return date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    _generateId() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    // ── Server B tracking calls ───────────────────────────────────────────────

    /** Fire-and-forget POST to Server B with JWT auth. */
    _callServerB(path, body) {
        if (!this.config.serverBUrl || !this.token) return;
        fetch(this.config.serverBUrl + path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + this.token,
            },
            body: JSON.stringify(body),
        }).catch(() => {});
    }

    // ── GA4 / Analytics Tracking ────────────────────────────────────────────

    _pushGA4(event, params) {
        try {
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push(Object.assign({ event: event }, params || {}));
        } catch (e) { /* silent */ }
    }

    _trackProductImpression(links) {
        if (!links || !links.length) return;
        var items = [];
        var self = this;
        links.forEach(function(link, idx) {
            if (!link.product_id) return;
            items.push({
                item_id: link.product_id,
                item_name: link.label,
                item_brand: 'Voltimax',
                item_category: 'Chat Recommendation',
                item_variant: link.style === 'alternative' ? 'cheaper_alternative' : 'primary',
                price: link.product_price || 0,
                index: idx,
                item_list_id: 'groot_chat',
                item_list_name: 'Groot Chat Recommendations',
            });
        });
        if (items.length > 0) {
            self._pushGA4('view_item_list', {
                item_list_id: 'groot_chat',
                item_list_name: 'Groot Chat Recommendations',
                items: items,
                groot_session: self._chatId || '',
            });
        }
    }

    _trackProductClick(link, index) {
        if (!link || !link.product_id) return;
        var item = {
            item_id: link.product_id,
            item_name: link.label,
            item_brand: 'Voltimax',
            item_category: 'Chat Recommendation',
            item_variant: link.style === 'alternative' ? 'cheaper_alternative' : 'primary',
            price: link.product_price || 0,
            index: index || 0,
            item_list_id: 'groot_chat',
            item_list_name: 'Groot Chat Recommendations',
        };
        // GA4 standard select_item event
        this._pushGA4('select_item', {
            item_list_id: 'groot_chat',
            item_list_name: 'Groot Chat Recommendations',
            items: [item],
            groot_session: this._chatId || '',
        });
        // Set attribution cookie for purchase tracking (30 min expiry)
        try {
            var attr = JSON.stringify({
                chat_id: this._chatId || '',
                session_id: this._sessionId || '',
                product_id: link.product_id,
                product_name: link.label,
                product_price: link.product_price || 0,
                ts: Date.now(),
            });
            document.cookie = 'groot_attribution=' + encodeURIComponent(attr) + ';path=/;max-age=1800;SameSite=Lax';
        } catch (e) { /* silent */ }
    }

    // ── Config + bubble ───────────────────────────────────────────────────────

    _loadConfig() {
        // Try to restore an active session first (page navigation)
        if (this._restoreSession()) {
            // Session restored — bubble hidden while the window is open,
            // visible when the chat was restored minimized.
            this._renderBubble();
            if (this._bubbleEl && !this._minimized) this._bubbleEl.style.display = 'none';
            return;
        }

        this.httpClient.get(this.options.configUrl, (response) => {
            try {
                this.config = JSON.parse(response);
            } catch (e) {
                return;
            }
            if (!this.config.enabled) return;
            this._renderBubble();
            this._renderTeaser();
            this._scheduleAttention();
        });
    }

    // ── Attention cue: gentle jump + soft chime shortly after load ───────────
    // Lets visitors spot the chat. Once per browser session, only while the
    // chat is closed; motion respects prefers-reduced-motion (CSS side).
    _scheduleAttention() {
        try {
            if (sessionStorage.getItem('voltimax_chat_attention_seen')) return;
            sessionStorage.setItem('voltimax_chat_attention_seen', '1');
        } catch (e) { return; }
        var self = this;
        setTimeout(function() {
            if (self.state !== 'CLOSED' || !self._bubbleEl) return;
            var btn = self._bubbleEl.querySelector('.voltimax-chat-bubble__button');
            if (!btn) return;
            btn.classList.add('voltimax-chat-bubble__button--attention');
            btn.addEventListener('animationend', function() {
                btn.classList.remove('voltimax-chat-bubble__button--attention');
            }, { once: true });
            self._playChime();
        }, 2500);
    }

    // Two-note WebAudio chime (C5→G5), quiet and short. Browsers block audio
    // before a user gesture; if blocked, retry once on the first interaction.
    _playChime() {
        var self = this;
        var play = function() {
            try {
                var Ctx = window.AudioContext || window.webkitAudioContext;
                if (!Ctx) return false;
                var ctx = new Ctx();
                if (ctx.state === 'suspended') { ctx.close(); return false; }
                var now = ctx.currentTime;
                [523.25, 783.99].forEach(function(freq, i) {
                    var osc = ctx.createOscillator();
                    var gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    var t = now + i * 0.12;
                    gain.gain.setValueAtTime(0, t);
                    gain.gain.linearRampToValueAtTime(0.06, t + 0.02);
                    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.start(t);
                    osc.stop(t + 0.55);
                });
                setTimeout(function() { ctx.close(); }, 1200);
                return true;
            } catch (e) { return false; }
        };
        if (play()) return;
        var retry = function() {
            document.removeEventListener('pointerdown', retry);
            document.removeEventListener('keydown', retry);
            if (self.state !== 'CLOSED') return;
            play();
        };
        document.addEventListener('pointerdown', retry, { once: true });
        document.addEventListener('keydown', retry, { once: true });
    }

    _renderBubble() {
        const bubble = document.createElement('div');
        bubble.className = 'voltimax-chat-bubble voltimax-chat-bubble--' + this.config.widgetPosition;
        bubble.style.setProperty('--vtx-primary', this.config.primaryColor);

        const btn = document.createElement('button');
        btn.className = 'voltimax-chat-bubble__button';
        btn.setAttribute('aria-label', 'Chat öffnen');
        // Safe: hardcoded SVG — chat bubble with three typing dots inside
        btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><circle class="vtx-ldot" cx="8" cy="10" r="1.4" fill="currentColor" stroke="none"></circle><circle class="vtx-ldot" cx="12" cy="10" r="1.4" fill="currentColor" stroke="none"></circle><circle class="vtx-ldot" cx="16" cy="10" r="1.4" fill="currentColor" stroke="none"></circle></svg>';

        const badge = document.createElement('span');
        badge.className = 'voltimax-chat-bubble__badge';
        badge.style.display = 'none';
        badge.textContent = '0';

        btn.addEventListener('click', () => this._onBubbleClick());
        bubble.appendChild(btn);
        // On the wrapper, NOT the button: the button clips overflow (shimmer
        // effect), which cut the badge to a sliver.
        bubble.appendChild(badge);
        document.body.appendChild(bubble);
        this._bubbleEl = bubble;
    }

    // ── First-visit teaser: "Hast du eine Frage?" next to the bubble ─────────
    // Shown once per browser session, ~1.5s after load, only while the chat
    // is closed. Click opens the chat; scrolling down or the × dismisses it.
    _renderTeaser() {
        try {
            if (sessionStorage.getItem('voltimax_chat_teaser_seen')) return;
        } catch (e) { return; }
        if (this.state !== 'CLOSED' || !this._bubbleEl) return;

        var self = this;
        setTimeout(function() {
            if (self.state !== 'CLOSED' || document.querySelector('.voltimax-chat-teaser')) return;

            var teaser = document.createElement('div');
            var pos = self.config && self.config.widgetPosition === 'bottom-left' ? 'bottom-left' : 'bottom-right';
            teaser.className = 'voltimax-chat-teaser voltimax-chat-teaser--' + pos;
            teaser.setAttribute('role', 'button');
            teaser.setAttribute('tabindex', '0');
            teaser.setAttribute('aria-label', 'Chat \u00f6ffnen: Hast du eine Frage?');

            var text = document.createElement('span');
            text.className = 'voltimax-chat-teaser__text';
            text.textContent = 'Hast du eine Frage? \uD83D\uDCAC';
            teaser.appendChild(text);

            var close = document.createElement('button');
            close.className = 'voltimax-chat-teaser__close';
            close.setAttribute('aria-label', 'Hinweis schlie\u00dfen');
            close.textContent = '\u00d7';
            close.addEventListener('click', function(e) {
                e.stopPropagation();
                self._dismissTeaser();
            });
            teaser.appendChild(close);

            var open = function() { self._dismissTeaser(); self._onBubbleClick(); };
            teaser.addEventListener('click', open);
            teaser.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
            });

            document.body.appendChild(teaser);
            self._teaserEl = teaser;

            // Visitor scrolled down = browsing — get out of the way
            self._teaserScrollHandler = function() {
                if (window.scrollY > 150) self._dismissTeaser();
            };
            window.addEventListener('scroll', self._teaserScrollHandler, { passive: true });

            // Opening the chat via the bubble also dismisses it
            var btn = self._bubbleEl.querySelector('.voltimax-chat-bubble__button');
            if (btn) btn.addEventListener('click', function() { self._dismissTeaser(); }, { once: true });
        }, 1500);
    }

    _dismissTeaser() {
        try { sessionStorage.setItem('voltimax_chat_teaser_seen', '1'); } catch (e) { /* silent */ }
        if (this._teaserScrollHandler) {
            window.removeEventListener('scroll', this._teaserScrollHandler);
            this._teaserScrollHandler = null;
        }
        var teaser = this._teaserEl || document.querySelector('.voltimax-chat-teaser');
        if (!teaser) return;
        this._teaserEl = null;
        teaser.classList.add('voltimax-chat-teaser--hide');
        setTimeout(function() { if (teaser.parentNode) teaser.remove(); }, 300);
    }

    _onBubbleClick() {
        if (this._minimized) {
            this._unminimize();
        } else if (this.state === 'CLOSED') {
            this._open();
        } else {
            this._minimize();
        }
    }

    // ── Open / minimize / close ───────────────────────────────────────────────

    _open() {
        this.state = 'OPEN';
        if (this._bubbleEl) this._bubbleEl.style.display = 'none';
        this._renderWidget();

        // Check for returning user
        let savedUser = null;
        try {
            const stored = localStorage.getItem('voltimax_chat_user');
            if (stored) savedUser = JSON.parse(stored);
        } catch (e) {}

        if (savedUser && savedUser.email && savedUser.timestamp &&
            (Date.now() - savedUser.timestamp < 24 * 3600 * 1000)) {
            this._showHome(savedUser);
        } else {
            this._showHome(null);
        }
    }

    _minimize() {
        this._minimized = true;
        if (this.state === 'CHATTING') this._saveSession();
        const widget = document.querySelector('.voltimax-chat-widget');
        if (widget) {
            widget.style.animation = 'vtx-widget-out 0.35s cubic-bezier(0.5, 0, 0.75, 0) forwards';
            widget.addEventListener('animationend', () => {
                widget.style.display = 'none';
                widget.style.animation = '';
            }, { once: true });
        }
        // Show bubble after a short delay so it appears as widget collapses into it
        setTimeout(() => {
            if (this._bubbleEl) this._bubbleEl.style.display = '';
        }, 200);
    }

    _unminimize() {
        this._minimized = false;
        if (this.state === 'CHATTING') {
            this._saveSession();
            // Opening the chat here is an explicit "continue in this tab"
            if (this._yielded) this._resumeHere();
        }
        this._unreadCount = 0;
        const badge = this._bubbleEl?.querySelector('.voltimax-chat-bubble__badge');
        if (badge) badge.style.display = 'none';
        if (this._bubbleEl) this._bubbleEl.style.display = 'none';
        const widget = document.querySelector('.voltimax-chat-widget');
        if (widget) {
            widget.style.display = 'flex';
            widget.style.animation = 'vtx-widget-in 0.4s cubic-bezier(0.34, 1.56, 0.64, 1) both';
        }
    }

    _toggleExpand() {
        this._expanded = !this._expanded;
        const widget = document.querySelector('.voltimax-chat-widget');
        if (!widget) return;
        widget.classList.toggle('voltimax-chat-widget--expanded', this._expanded);
        // Update button icon
        const expandBtn = widget.querySelector('.voltimax-chat-widget__expand');
        if (expandBtn) {
            if (this._expanded) {
                expandBtn.title = 'Verkleinern';
                expandBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
            } else {
                expandBtn.title = 'Vergr\u00f6\u00dfern';
                expandBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
            }
        }
    }

    _close() {
        // Show rating overlay before closing if user was chatting
        if (this.state === 'CHATTING' && !document.querySelector('.voltimax-chat-rating')) {
            this._showRatingOverlay();
            return;
        }
        this._doClose();
    }

    _doClose() {
        if (this._sessionId) {
            this._callServerB('/chat/end', { session_id: this._sessionId });
        }

        this.state          = 'CLOSED';
        this._minimized     = false;
        this._expanded      = false;
        this._chatId        = null;
        this._sessionId     = null;
        this._unreadCount   = 0;
        this._streamingRow  = null;
        this._streamingRaw  = '';
        this._pendingSubCards = null;
        this._pendingFreeText = null;
        this._expandedTopicId = null;

        try { localStorage.removeItem('voltimax_chat_id'); } catch (e) {}
        this._clearSession();
        if (this.ws)       { this.ws.close();       this.ws       = null; }
        if (this.sse)      { this.sse.close();      this.sse      = null; }
        if (this._earlySse){ this._earlySse.close(); this._earlySse = null; }

        const widget = document.querySelector('.voltimax-chat-widget');
        if (widget) widget.remove();

        if (this._bubbleEl) this._bubbleEl.style.display = '';
        const badge = this._bubbleEl?.querySelector('.voltimax-chat-bubble__badge');
        if (badge) badge.style.display = 'none';
    }

    _resetChat() {
        // Close current session and re-open fresh
        this._doClose();
        setTimeout(() => this._open(), 200);
    }

    // ── Rating overlay ────────────────────────────────────────────────────────

    _showRatingOverlay() {
        // First collapse the main widget into the bubble
        const widget = document.querySelector('.voltimax-chat-widget');
        if (widget) {
            widget.style.animation = 'vtx-widget-out 0.35s cubic-bezier(0.5, 0, 0.75, 0) forwards';
            widget.addEventListener('animationend', () => {
                widget.style.display = 'none';
                widget.style.animation = '';
                this._showRatingBubble();
            }, { once: true });
        } else {
            this._showRatingBubble();
        }
    }

    _showRatingBubble() {
        // Remove any existing rating bubble
        const existing = document.querySelector('.vtx-rating-bubble');
        if (existing) existing.remove();

        const posClass = this.config?.widgetPosition === 'bottom-left' ? 'vtx-rating-bubble--bottom-left' : 'vtx-rating-bubble--bottom-right';

        const bubble = document.createElement('div');
        bubble.className = 'vtx-rating-bubble ' + posClass;
        bubble.style.setProperty('--vtx-primary-start', this.config?.primaryColor || '#4338CA');
        bubble.style.setProperty('--vtx-primary-end', this.config?.secondaryColor || this._shiftColor(this.config?.primaryColor || '#4338CA', 30));

        const title = document.createElement('div');
        title.className = 'vtx-rating-bubble__title';
        title.textContent = 'Wie war dein Chat?';
        bubble.appendChild(title);

        const starsRow = document.createElement('div');
        starsRow.className = 'vtx-rating-bubble__stars';

        const starBtns = [];
        let selectedRating = 0;

        for (let i = 1; i <= 5; i++) {
            const star = document.createElement('button');
            star.className = 'vtx-rating-bubble__star';
            star.textContent = '\u2605';
            const idx = i;
            star.addEventListener('mouseenter', () => {
                starBtns.forEach((s, j) => s.classList.toggle('is-hovered', j < idx));
            });
            star.addEventListener('mouseleave', () => {
                starBtns.forEach((s, j) => s.classList.toggle('is-hovered', j < selectedRating));
            });
            star.addEventListener('click', () => {
                selectedRating = idx;
                starBtns.forEach((s, j) => {
                    s.classList.toggle('is-selected', j < idx);
                    s.classList.remove('is-hovered');
                });
                this._submitRating(idx, bubble);
            });
            starsRow.appendChild(star);
            starBtns.push(star);
        }
        bubble.appendChild(starsRow);

        const skipBtn = document.createElement('button');
        skipBtn.className = 'vtx-rating-bubble__skip';
        skipBtn.textContent = '\u00dcberspringen';
        skipBtn.addEventListener('click', () => {
            this._collapseRatingBubble(bubble);
        });
        bubble.appendChild(skipBtn);

        document.body.appendChild(bubble);
    }

    _submitRating(stars, bubble) {
        if (this._sessionId) {
            this._callServerB('/chat/rating', { session_id: this._sessionId, rating: stars });
        }
        // Morph into thank you
        bubble.innerHTML = '';
        bubble.classList.add('vtx-rating-bubble--thanks');
        const thanks = document.createElement('div');
        thanks.className = 'vtx-rating-bubble__thanks';
        thanks.textContent = 'Danke! \uD83D\uDE4F';
        bubble.appendChild(thanks);

        // After 1s, collapse into the chat bubble
        setTimeout(() => {
            this._collapseRatingBubble(bubble);
        }, 1200);
    }

    _collapseRatingBubble(bubble) {
        bubble.style.animation = 'vtx-rating-collapse 0.35s cubic-bezier(0.5, 0, 0.75, 0) forwards';
        bubble.addEventListener('animationend', () => {
            bubble.remove();
            this._doClose();
        }, { once: true });
    }

    // ── Widget chrome ─────────────────────────────────────────────────────────

    _renderWidget() {
        let widget = document.querySelector('.voltimax-chat-widget');
        if (widget) {
            widget.style.display = 'flex';
            return;
        }

        widget = document.createElement('div');
        widget.className = 'voltimax-chat-widget voltimax-chat-widget--' + this.config.widgetPosition;
        widget.style.setProperty('--vtx-primary', this.config.primaryColor);
        var _pc = this.config.primaryColor || '#4338CA';
        widget.style.setProperty('--vtx-primary-start', _pc);
        // Secondary gradient color — configurable or auto-computed
        var _secondary = this.config.secondaryColor || this._shiftColor(_pc, 30);
        widget.style.setProperty('--vtx-primary-end', _secondary);

        this._applyTheme(this.config.themeMode || 'light');

        // Header — Dynamic Island style
        const header = document.createElement('div');
        header.className = 'voltimax-chat-widget__header';

        // Compact view (default) — just status dot + title
        const compactView = document.createElement('div');
        compactView.className = 'voltimax-chat-widget__header-compact';

        const statusDot = document.createElement('span');
        statusDot.className = 'voltimax-chat-widget__status-dot';

        const compactTitle = document.createElement('span');
        compactTitle.className = 'voltimax-chat-widget__compact-title';
        compactTitle.textContent = this.config.widgetTitle || 'Groot';

        compactView.appendChild(statusDot);
        compactView.appendChild(compactTitle);
        header.appendChild(compactView);

        // Expanded view (on hover) — left: expand + info, right: menu + min + close
        const expandedView = document.createElement('div');
        expandedView.className = 'voltimax-chat-widget__header-expanded';

        // Left group: expand button + title/status
        const leftGroup = document.createElement('div');
        leftGroup.className = 'voltimax-chat-widget__header-left';

        const expandBtn = document.createElement('button');
        expandBtn.className = 'voltimax-chat-widget__expand';
        expandBtn.setAttribute('aria-label', 'Vergrößern');
        expandBtn.title = 'Vergr\u00f6\u00dfern';
        expandBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
        expandBtn.addEventListener('click', () => this._toggleExpand());
        leftGroup.appendChild(expandBtn);

        const headerInfo = document.createElement('div');
        headerInfo.className = 'voltimax-chat-widget__header-info';

        const headerText = document.createElement('div');
        headerText.className = 'voltimax-chat-widget__header-text';

        const titleEl = document.createElement('span');
        titleEl.className = 'voltimax-chat-widget__title';
        titleEl.textContent = this.config.widgetTitle;

        const status = document.createElement('span');
        status.className = 'voltimax-chat-widget__status';
        status.textContent = 'Online';

        const chatIdEl = document.createElement('span');
        chatIdEl.className = 'voltimax-chat-widget__chat-id';
        chatIdEl.style.display = 'none';

        headerText.appendChild(titleEl);
        headerText.appendChild(status);
        headerText.appendChild(chatIdEl);
        headerInfo.appendChild(headerText);
        leftGroup.appendChild(headerInfo);
        expandedView.appendChild(leftGroup);

        // Right group: three-dots menu + minimize + close
        const actions = document.createElement('div');
        actions.className = 'voltimax-chat-widget__header-actions';

        // Three-dots menu button + dropdown
        // Three-dots menu — button stays in header, dropdown on document.body
        const menuBtn = document.createElement('button');
        menuBtn.setAttribute('aria-label', 'Men\u00fc');
        menuBtn.title = 'Men\u00fc';
        menuBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
        actions.appendChild(menuBtn);

        const menuDropdown = document.createElement('div');
        menuDropdown.className = 'vtx-header-menu__dropdown';
        menuDropdown.style.cssText = 'display:none;position:fixed;z-index:200000;';

        const newChatItem = document.createElement('button');
        newChatItem.className = 'vtx-header-menu__item voltimax-chat-widget__new-chat';
        newChatItem.style.display = 'none';
        newChatItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 101.056-4.11L1 10"/></svg><span>Neuer Chat</span>';
        newChatItem.addEventListener('click', () => { menuDropdown.style.display = 'none'; this._startNewChat(); });
        menuDropdown.appendChild(newChatItem);

        const copyItem = document.createElement('button');
        copyItem.className = 'vtx-header-menu__item voltimax-chat-widget__copy';
        copyItem.style.display = 'none';
        copyItem.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg><span>Transkript kopieren</span>';
        copyItem.addEventListener('click', () => { menuDropdown.style.display = 'none'; this._copyTranscript(); });
        menuDropdown.appendChild(copyItem);

        document.body.appendChild(menuDropdown);
        this._menuDropdown = menuDropdown;
        this._menuBtn = menuBtn;

        menuBtn.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (menuDropdown.style.display !== 'none') {
                menuDropdown.style.display = 'none';
                return;
            }
            var rect = menuBtn.getBoundingClientRect();
            menuDropdown.style.top = (rect.bottom + 6) + 'px';
            menuDropdown.style.right = (window.innerWidth - rect.right) + 'px';
            menuDropdown.style.left = 'auto';
            menuDropdown.style.display = 'block';
        });

        document.addEventListener('mousedown', (e) => {
            if (menuDropdown.style.display !== 'none' && !menuBtn.contains(e.target) && !menuDropdown.contains(e.target)) {
                menuDropdown.style.display = 'none';
            }
        });

        const minBtn = document.createElement('button');
        minBtn.setAttribute('aria-label', 'Minimieren');
        minBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg>';
        minBtn.addEventListener('click', () => this._minimize());
        actions.appendChild(minBtn);

        const closeBtn = document.createElement('button');
        closeBtn.setAttribute('aria-label', 'Schließen');
        closeBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>';
        closeBtn.addEventListener('click', () => this._close());
        actions.appendChild(closeBtn);

        expandedView.appendChild(actions);
        header.appendChild(expandedView);
        widget.appendChild(header);

        const body = document.createElement('div');
        body.className = 'voltimax-chat-widget__body';
        widget.appendChild(body);

        if (this.config.customCss) {
            const style = document.createElement('style');
            style.textContent = this.config.customCss;
            widget.appendChild(style);
        }

        document.body.appendChild(widget);
    }

    // ── Theme (C1) ───────────────────────────────────────────────────────────

    _applyTheme(mode) {
        const widget = document.querySelector('.voltimax-chat-widget');
        if (!widget) return;

        const applyDark = (dark) => {
            // 2.10.0: dark mode disabled — the dark palette predates the
            // GrootDesk light redesign. The admin option stays but is inert
            // until the 2.11 dark redesign.
            void dark;
            widget.classList.remove('voltimax-chat-widget--dark');
        };

        if (mode === 'dark') {
            applyDark(true);
        } else if (mode === 'auto') {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            applyDark(mq.matches);
            // Replace any previous listener with a fresh one
            if (this._darkMqListener) mq.removeEventListener('change', this._darkMqListener);
            this._darkMqListener = (e) => applyDark(e.matches);
            mq.addEventListener('change', this._darkMqListener);
        } else {
            applyDark(false);
        }
    }

    // ── Connection status (C2) ────────────────────────────────────────────────

    _setConnectionStatus(status) {
        const widget = document.querySelector('.voltimax-chat-widget');
        if (!widget) return;
        const colors = {
            ws:           ['#4ade80', 'rgba(74,222,128,0.3)'],
            sse:          ['#fbbf24', 'rgba(251,191,36,0.3)'],
            disconnected: ['#f87171', 'rgba(248,113,113,0.3)'],
        };
        const [color, glow] = colors[status] || colors.ws;
        widget.style.setProperty('--vtx-status-color', color);
        widget.style.setProperty('--vtx-status-glow', glow);
    }

    // ── Sounds via Web Audio API (C4) ─────────────────────────────────────────

    _playSound(type) {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc  = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            if (type === 'outgoing') {
                osc.frequency.setValueAtTime(600, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.08);
                gain.gain.setValueAtTime(0.1, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.12);
            } else {
                osc.frequency.setValueAtTime(880, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.1);
                gain.gain.setValueAtTime(0.12, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.15);
            }
            osc.onended = () => ctx.close();
        } catch (e) {}
    }

    // ── Home screen (input-first layout) ──────────────────────────────────────

    _showHome(savedUser) {
        this.state = 'TOPICS';
        this._expandedTopicId = null;

        // Hide chat-only header controls
        const newChatBtn = document.querySelector('.voltimax-chat-widget__new-chat');
        if (newChatBtn) newChatBtn.style.display = 'none';
        const copyBtn = document.querySelector('.voltimax-chat-widget__copy');
        if (copyBtn) copyBtn.style.display = 'none';
        const chatIdEl = document.querySelector('.voltimax-chat-widget__chat-id');
        if (chatIdEl) chatIdEl.style.display = 'none';

        const body = document.querySelector('.voltimax-chat-widget__body');
        body.textContent = '';

        const container = document.createElement('div');
        container.className = 'vtx-home';

        // Branding lives in the header ("GrootDesk Support") — the home body
        // stays clean: no logo block, straight to the conversation starter.

        // Returning user — show continue/new chat choice
        if (savedUser && savedUser.name) {
            const firstName = (savedUser.name || '').split(' ')[0] || savedUser.name;

            const resumeBar = document.createElement('div');
            resumeBar.className = 'vtx-resume-bar';

            const resumeText = document.createElement('div');
            resumeText.className = 'vtx-resume-bar__info';
            resumeText.textContent = 'Willkommen zurück, ' + firstName + '!';
            resumeBar.appendChild(resumeText);

            const resumeActions = document.createElement('div');
            resumeActions.className = 'vtx-resume-bar__actions';

            const continueBtn = document.createElement('button');
            continueBtn.className = 'vtx-resume-bar__btn vtx-resume-bar__btn--primary';
            continueBtn.textContent = 'Weiter';
            continueBtn.addEventListener('click', () => {
                resumeBar.remove();
            });

            const newChatBtn2 = document.createElement('button');
            newChatBtn2.className = 'vtx-resume-bar__btn vtx-resume-bar__btn--secondary';
            newChatBtn2.textContent = 'Neuer Chat';
            newChatBtn2.addEventListener('click', () => {
                try { localStorage.removeItem('voltimax_chat_user'); } catch (e) {}
                this.token = null;
                this.customerContext = null;
                nameInput.value = '';
                resumeBar.remove();
            });

            resumeActions.appendChild(continueBtn);
            resumeActions.appendChild(newChatBtn2);
            resumeBar.appendChild(resumeActions);
            container.appendChild(resumeBar);
        }

        // Identity fields (always visible, name is required)
        const identity = document.createElement('div');
        identity.className = 'vtx-home__identity vtx-home__identity--open';

        const identityFields = document.createElement('div');
        identityFields.className = 'vtx-home__identity-fields is-open';

        const nameInput = document.createElement('input');
        nameInput.className = 'vtx-home__identity-input';
        nameInput.type = 'text';
        nameInput.placeholder = 'Dein Name *';
        nameInput.required = true;
        if (savedUser && savedUser.name) nameInput.value = savedUser.name;

        identityFields.appendChild(nameInput);
        identity.appendChild(identityFields);

        container.appendChild(identity);

        // Primary input area — matches chat session input style
        const inputRow = document.createElement('div');
        inputRow.className = 'vtx-home__input-row';

        const mainInput = document.createElement('input');
        mainInput.type = 'text';
        mainInput.placeholder = 'Wie kann ich dir helfen?';

        const sendBtn = document.createElement('button');
        sendBtn.setAttribute('aria-label', 'Nachricht senden');
        sendBtn.innerHTML = '<span class="vtx-orb vtx-orb--send" aria-hidden="true"><span class="vtx-orb__petal vtx-orb__petal--r"></span><span class="vtx-orb__petal vtx-orb__petal--b"></span><span class="vtx-orb__petal vtx-orb__petal--c"></span><span class="vtx-orb__flare"></span></span>';

        const doFreeText = () => {
            const text = mainInput.value.trim();
            if (!text) return;

            const name = nameInput.value.trim();
            if (!name) {
                nameInput.style.borderColor = '#ef4444';
                nameInput.focus();
                setTimeout(() => { nameInput.style.borderColor = ''; }, 2000);
                return;
            }

            // Animate the message flying down
            const inputRect = inputRow.getBoundingClientRect();
            const flyMsg = document.createElement('div');
            flyMsg.className = 'vtx-fly-message';
            flyMsg.textContent = text;
            flyMsg.style.position = 'fixed';
            flyMsg.style.left = inputRect.left + 'px';
            flyMsg.style.top = inputRect.top + 'px';
            flyMsg.style.width = inputRect.width + 'px';
            document.body.appendChild(flyMsg);

            // Target: bottom of widget body
            const body = document.querySelector('.voltimax-chat-widget__body');
            const targetY = body ? body.getBoundingClientRect().bottom - 40 : inputRect.top + 200;

            requestAnimationFrame(() => {
                flyMsg.style.transition = 'all 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
                flyMsg.style.top = targetY + 'px';
                flyMsg.style.opacity = '0';
                flyMsg.style.transform = 'scale(0.8)';
            });
            setTimeout(() => flyMsg.remove(), 500);

            this._pendingFreeText = text;
            mainInput.value = '';
            this._anonymousVerifyAndStart('general');
        };

        mainInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); doFreeText(); }
        });
        sendBtn.addEventListener('click', doFreeText);

        inputRow.appendChild(mainInput);
        inputRow.appendChild(sendBtn);
        container.appendChild(inputRow);

        // Quiet section caption above the suggestion cloud
        const suggestionsLabel = document.createElement('div');
        suggestionsLabel.className = 'vtx-home__suggestions-label';
        suggestionsLabel.textContent = 'Beliebte Themen';
        container.appendChild(suggestionsLabel);

        // Smart suggestion chips — populated from server after auth, with defaults as fallback
        const suggestionsContainer = document.createElement('div');
        suggestionsContainer.className = 'vtx-home__suggestions';
        this._homeSuggestionsContainer = suggestionsContainer;

        // Show default suggestions immediately; server suggestions replace them
        // after auth. Icon first, then the label.
        const defaultSuggestions = [
            '\ud83d\udce6 Bestellstatus',
            '\ud83d\udd0b Produktsuche',
            '\ud83d\ude97 Fahrzeug-Batterie',
            '\u21a9\ufe0f Retoure & Erstattung',
            '\ud83d\ude9a Versand & Lieferzeit',
            '\ud83e\uddfe Rechnung anfordern',
            '\u267b\ufe0f Batteriepfand',
            '\ud83c\udfab Ticket-Status',
            '\ud83d\udcc4 R\u00fcckgaberecht',
            '\ud83d\udcac Support kontaktieren',
            '\ud83d\udcb3 Zahlungsstatus',
            '\ud83d\udd12 Mein Konto',
            '\u26a0\ufe0f Problem melden',
            '\ud83d\udd0c Zubeh\u00f6r',
        ];
        this._renderHomeSuggestions(suggestionsContainer, defaultSuggestions, mainInput, doFreeText);
        container.appendChild(suggestionsContainer);

        // Consent footer
        const consentFooter = document.createElement('div');
        consentFooter.className = 'voltimax-chat-consent-footer';

        const footerText = document.createTextNode('Mit der Nutzung stimmst du unserer ');
        consentFooter.appendChild(footerText);

        if (this.config.privacyPolicyUrl) {
            const link = document.createElement('a');
            link.href = this.config.privacyPolicyUrl;
            link.target = '_blank';
            link.rel = 'noopener';
            link.textContent = 'Datenschutzerkl\u00e4rung';
            consentFooter.appendChild(link);
        } else {
            consentFooter.appendChild(document.createTextNode('Datenschutzerkl\u00e4rung'));
        }

        consentFooter.appendChild(document.createTextNode(' zu.'));
        container.appendChild(consentFooter);

        body.appendChild(container);

        // Store references for later use
        this._homeNameInput = nameInput;
    }

    _renderHomeSuggestions(container, suggestions, inputEl, submitFn) {
        container.textContent = '';
        suggestions.forEach(rawText => {
            // Icon before the text: split a leading emoji/symbol into its own span
            const raw = String(rawText);
            const m = /^([^\p{L}\p{N}]+)\s*(.*)$/u.exec(raw);
            const chip = document.createElement('button');
            chip.className = 'vtx-topic-chip';
            if (m && m[2]) {
                const iconSpan = document.createElement('span');
                iconSpan.className = 'vtx-topic-chip__icon';
                iconSpan.textContent = m[1].trim();
                chip.appendChild(iconSpan);
                chip.appendChild(document.createTextNode(m[2]));
            } else {
                chip.textContent = raw;
            }
            chip.addEventListener('click', () => {
                inputEl.value = (m && m[2]) ? m[2] : raw;
                submitFn();
            });
            container.appendChild(chip);
        });
    }

    // ── Topic chips rendering ─────────────────────────────────────────────────

    _renderTopicChips(container) {
        const topics = (this.topics && this.topics.length)
            ? this.topics
            : this._getDefaultTopics();

        topics.forEach(t => {
            const chip = document.createElement('button');
            chip.className = 'vtx-topic-chip';
            chip.dataset.topicId = t.id;

            const icon = document.createElement('span');
            icon.className = 'vtx-topic-chip__icon';
            icon.textContent = t.icon || '\ud83d\udcac';
            chip.appendChild(icon);

            const label = document.createTextNode(t.title);
            chip.appendChild(label);

            chip.addEventListener('click', () => {
                if (this._expandedTopicId === t.id) {
                    this._collapseTopic();
                } else {
                    this._expandTopic(t.id, chip);
                }
            });

            container.appendChild(chip);
        });
    }

    _expandTopic(topicId, chipEl) {
        const topics = (this.topics && this.topics.length)
            ? this.topics
            : this._getDefaultTopics();

        const topic = topics.find(t => t.id === topicId);
        if (!topic || !topic.sub_cards || !topic.sub_cards.length) {
            // No sub-cards, start directly
            this._onSubTopicClick(topicId, topicId, topic.tier || 0);
            return;
        }

        // Collapse any previously expanded topic
        this._collapseTopic();

        // Mark this chip as active
        this._expandedTopicId = topicId;
        chipEl.classList.add('vtx-topic-chip--active');

        // Render sub-topic chips in the subtopics area
        const subtopicsArea = document.querySelector('.vtx-subtopics-area');
        if (!subtopicsArea) return;
        subtopicsArea.textContent = '';

        const subRow = document.createElement('div');
        subRow.className = 'vtx-subtopics';

        topic.sub_cards.forEach(sub => {
            const subChip = document.createElement('button');
            subChip.className = 'vtx-subtopic-chip';

            const subIcon = document.createElement('span');
            subIcon.className = 'vtx-subtopic-chip__icon';
            subIcon.textContent = sub.icon || '\uD83D\uDCAC';
            subChip.appendChild(subIcon);

            const subLabel = document.createTextNode(sub.title);
            subChip.appendChild(subLabel);

            subChip.addEventListener('click', () => {
                this._onSubTopicClick(topicId, sub.id, topic.tier || 0);
            });

            subRow.appendChild(subChip);
        });

        subtopicsArea.appendChild(subRow);
    }

    _collapseTopic() {
        this._expandedTopicId = null;

        // Remove active class from all chips
        document.querySelectorAll('.vtx-topic-chip--active').forEach(el => {
            el.classList.remove('vtx-topic-chip--active');
        });

        // Clear subtopics area
        const subtopicsArea = document.querySelector('.vtx-subtopics-area');
        if (subtopicsArea) subtopicsArea.textContent = '';
    }

    // ── Sub-topic click handler ───────────────────────────────────────────────

    _onSubTopicClick(topicId, subTopicId, tier) {
        const name = this._homeNameInput ? this._homeNameInput.value.trim() : '';

        if (!name) {
            // Name is required — highlight the field
            if (this._homeNameInput) {
                this._homeNameInput.style.borderColor = '#ef4444';
                this._homeNameInput.focus();
                setTimeout(() => { if (this._homeNameInput) this._homeNameInput.style.borderColor = ''; }, 2000);
            }
            return;
        }

        if (this.token) {
            // Already verified — go straight to chat
            if (tier === 2) {
                this._showOrderVerifyForm(subTopicId);
            } else {
                this._startChat(subTopicId);
            }
            return;
        }

        if (tier === 0) {
            // Tier 0: anonymous start, no email needed
            this._anonymousVerifyAndStart(subTopicId);
        } else if (tier === 1) {
            // Tier 1: needs identity — show account verify form
            this._showAccountVerifyForm(subTopicId);
        } else if (tier === 2) {
            // Tier 2: needs order — show order verify form
            this._showOrderVerifyForm(subTopicId);
        }
    }

    // ── Order verification form (Tier 2) ──────────────────────────────────────

    _showOrderVerifyForm(topicId) {
        const subtopicsArea = document.querySelector('.vtx-subtopics-area');
        if (!subtopicsArea) return;
        subtopicsArea.textContent = '';

        const form = document.createElement('div');
        form.className = 'vtx-verify-form';

        const title = document.createElement('div');
        title.className = 'vtx-verify-form__title';
        title.textContent = 'So finden wir deine Bestellung:';
        form.appendChild(title);

        const fields = document.createElement('div');
        fields.className = 'vtx-verify-form__fields';

        const orderInput = document.createElement('input');
        orderInput.className = 'vtx-verify-form__input';
        orderInput.type = 'text';
        orderInput.placeholder = 'Bestellnummer';
        orderInput.required = true;

        const postcodeInput = document.createElement('input');
        postcodeInput.className = 'vtx-verify-form__input';
        postcodeInput.type = 'text';
        postcodeInput.placeholder = 'PLZ';
        postcodeInput.required = true;

        fields.appendChild(orderInput);
        fields.appendChild(postcodeInput);
        form.appendChild(fields);

        const submitBtn = document.createElement('button');
        submitBtn.className = 'vtx-verify-form__submit';
        submitBtn.textContent = 'Suchen \u2192';
        form.appendChild(submitBtn);

        const errorDiv = document.createElement('div');
        errorDiv.className = 'vtx-verify-form__error';
        form.appendChild(errorDiv);

        const doSubmit = () => {
            const orderNum = orderInput.value.trim();
            const postcode = postcodeInput.value.trim();

            if (!orderNum || !postcode) {
                errorDiv.textContent = 'Bitte Bestellnummer und PLZ eingeben.';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Wird gesucht \u2026';
            errorDiv.textContent = '';

            const name = (this._homeNameInput ? this._homeNameInput.value.trim() : '') || 'Guest';
            const verifyEmail = '';

            this.httpClient.post(this.options.consentUrl, JSON.stringify({
                name: name, email: verifyEmail,
            }), () => {
                this.httpClient.post(this.options.verifyUrl, JSON.stringify({
                    name: name, email: verifyEmail, orderNumber: orderNum, postcode: postcode,
                }), (response) => {
                    try {
                        const result = JSON.parse(response);
                        if (result.error) {
                            errorDiv.textContent = result.message || 'Order not found. Please check your details.';
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Suchen \u2192';
                            return;
                        }
                        this.token = result.token;
                        this.customerContext = result.context;

                        // Save user name for returning user detection
                        if (name) {
                            try {
                                localStorage.setItem('voltimax_chat_user', JSON.stringify({
                                    name: name, timestamp: Date.now(),
                                }));
                            } catch (e) {}
                        }

                        this._startChat(topicId);
                    } catch (e) {
                        errorDiv.textContent = '\u00dcberpr\u00fcfung fehlgeschlagen. Bitte versuche es erneut.';
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Suchen \u2192';
                    }
                });
            });
        };

        submitBtn.addEventListener('click', doSubmit);
        orderInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });
        postcodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });

        subtopicsArea.appendChild(form);
        orderInput.focus();
    }

    // ── Account verification form (Tier 1) ───────────────────────────────────

    _showAccountVerifyForm(topicId) {
        const subtopicsArea = document.querySelector('.vtx-subtopics-area');
        if (!subtopicsArea) return;
        subtopicsArea.textContent = '';

        const form = document.createElement('div');
        form.className = 'vtx-verify-form';

        const title = document.createElement('div');
        title.className = 'vtx-verify-form__title';
        title.textContent = 'F\u00fcr Zugriff auf dein Konto:';
        form.appendChild(title);

        const fields = document.createElement('div');
        fields.className = 'vtx-verify-form__fields';

        const nameInput = document.createElement('input');
        nameInput.className = 'vtx-verify-form__input';
        nameInput.type = 'text';
        nameInput.placeholder = 'Your name';
        nameInput.required = true;

        const emailInput = document.createElement('input');
        emailInput.className = 'vtx-verify-form__input';
        emailInput.type = 'email';
        emailInput.placeholder = 'Deine E-Mail';
        emailInput.required = true;

        // Pre-fill name from home identity field
        if (this._homeNameInput && this._homeNameInput.value.trim()) {
            nameInput.value = this._homeNameInput.value.trim();
        }

        fields.appendChild(nameInput);
        fields.appendChild(emailInput);
        form.appendChild(fields);

        const submitBtn = document.createElement('button');
        submitBtn.className = 'vtx-verify-form__submit';
        submitBtn.textContent = 'Weiter \u2192';
        form.appendChild(submitBtn);

        const errorDiv = document.createElement('div');
        errorDiv.className = 'vtx-verify-form__error';
        form.appendChild(errorDiv);

        const doSubmit = () => {
            const name = nameInput.value.trim();
            const email = emailInput.value.trim();

            if (!name || !email) {
                errorDiv.textContent = 'Please enter your name and email.';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Wird gepr\u00fcft \u2026';
            errorDiv.textContent = '';

            this._verifyAndStart(topicId, name, email, '');
        };

        submitBtn.addEventListener('click', doSubmit);
        nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });
        emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });

        subtopicsArea.appendChild(form);
        nameInput.focus();
    }

    // ── Verification helpers ──────────────────────────────────────────────────

    _verifyAndStart(topicId, name, email, orderNumber) {
        this.httpClient.post(this.options.consentUrl, JSON.stringify({
            name: name, email: email,
        }), () => {
            this.httpClient.post(this.options.verifyUrl, JSON.stringify({
                name: name, email: email, orderNumber: orderNumber || '',
            }), (response) => {
                try {
                    const result = JSON.parse(response);
                    if (result.error) {
                        // Show error in form if it exists
                        const errorDiv = document.querySelector('.vtx-verify-form__error');
                        if (errorDiv) {
                            errorDiv.textContent = '\u00dcberpr\u00fcfung fehlgeschlagen. Bitte versuche es erneut.';
                            const btn = document.querySelector('.vtx-verify-form__submit');
                            if (btn) { btn.disabled = false; btn.textContent = 'Weiter \u2192'; }
                        }
                        return;
                    }
                    this.token = result.token;
                    this.customerContext = result.context;

                    // Save user for resume (24h)
                    try {
                        localStorage.setItem('voltimax_chat_user', JSON.stringify({
                            name: name, email: email, timestamp: Date.now(),
                        }));
                    } catch (e) {}

                    this._startChat(topicId);
                } catch (e) {
                    const errorDiv = document.querySelector('.vtx-verify-form__error');
                    if (errorDiv) {
                        errorDiv.textContent = '\u00dcberpr\u00fcfung fehlgeschlagen. Bitte versuche es erneut.';
                        const btn = document.querySelector('.vtx-verify-form__submit');
                        if (btn) { btn.disabled = false; btn.textContent = 'Weiter \u2192'; }
                    }
                }
            });
        });
    }

    _anonymousVerifyAndStart(topicId) {
        const body = document.querySelector('.voltimax-chat-widget__body');
        if (!body) return;

        // Show brief loading
        const loader = document.createElement('div');
        loader.className = 'voltimax-chat-loading';
        [1, 2, 3].forEach(() => loader.appendChild(document.createElement('span')));
        body.textContent = '';
        body.appendChild(loader);

        const guestName = (this._homeNameInput && this._homeNameInput.value.trim()) || 'Guest';
        const guestEmail = '';

        this.httpClient.post(this.options.consentUrl, JSON.stringify({
            name: guestName, email: guestEmail,
        }), () => {
            this.httpClient.post(this.options.verifyUrl, JSON.stringify({
                name: guestName, email: guestEmail, orderNumber: '',
            }), (response) => {
                try {
                    const result = JSON.parse(response);
                    if (!result.error) {
                        this.token = result.token;
                        this.customerContext = result.context;
                        this._startChat(topicId);
                        return;
                    }
                } catch (e) {}
                // If anonymous verify fails, fall back to home
                this._showHome(null);
            });
        });
    }

    // ── Topics data ───────────────────────────────────────────────────────────

    _getDefaultTopics() {
        return [
            {
                id: 'orders', title: 'Bestellungen', icon: '\uD83D\uDCE6',
                description: 'Verfolgen, zur\u00FCcksenden oder Problem melden',
                tier: 2,
                sub_cards: [
                    { id: 'order_status', title: 'Sendung verfolgen', icon: '\uD83D\uDE9A' },
                    { id: 'returns', title: 'R\u00FCckgabe / Erstattung', icon: '\u21A9\uFE0F' },
                    { id: 'order_issue', title: 'Problem mit Bestellung', icon: '\u26A0\uFE0F' },
                ],
            },
            {
                id: 'products', title: 'Produkte', icon: '\uD83D\uDECD\uFE0F',
                description: 'Finde das passende Produkt',
                tier: 0,
                sub_cards: [
                    { id: 'product_help', title: 'Produktfrage', icon: '\u2753' },
                    { id: 'stock', title: 'Lager & Verf\u00FCgbarkeit', icon: '\uD83D\uDCCA' },
                    { id: 'compatibility', title: 'Fahrzeug-Kompatibilit\u00E4t', icon: '\uD83D\uDE97' },
                ],
            },
            {
                id: 'shipping', title: 'Versand', icon: '\uD83D\uDE9B',
                description: 'Lieferzeiten und Optionen',
                tier: 0,
                sub_cards: [
                    { id: 'delivery_time', title: 'Lieferzeiten', icon: '\u23F1\uFE0F' },
                    { id: 'shipping_costs', title: 'Versandkosten', icon: '\uD83D\uDCB0' },
                    { id: 'express_delivery', title: 'Express', icon: '\u26A1' },
                ],
            },
            {
                id: 'account', title: 'Konto', icon: '\uD83D\uDC64',
                description: 'Zahlungen, Adressen, Rechnungen',
                tier: 1,
                sub_cards: [
                    { id: 'payment', title: 'Zahlung', icon: '\uD83D\uDCB3' },
                    { id: 'address', title: 'Adressen', icon: '\uD83D\uDCCD' },
                    { id: 'invoice', title: 'Rechnungen', icon: '\uD83E\uDDFE' },
                ],
            },
            {
                id: 'others', title: 'Mehr', icon: '\uD83D\uDCAC',
                description: 'FAQ, Beschwerden, Kontakt',
                tier: 1,
                sub_cards: [
                    { id: 'faq', title: 'FAQ', icon: '\uD83D\uDCD6' },
                    { id: 'complaint', title: 'Beschwerde', icon: '\uD83D\uDCE2' },
                ],
            },
        ];
    }

    // ── Topics connection ─────────────────────────────────────────────────────

    _connectForTopics(welcomeBanner) {
        this.state = 'CONNECTING';
        const body = document.querySelector('.voltimax-chat-widget__body');
        body.textContent = '';

        const loader = document.createElement('div');
        loader.className = 'voltimax-chat-loading';
        [1, 2, 3].forEach(() => loader.appendChild(document.createElement('span')));
        body.appendChild(loader);

        const url = this.config.serverBUrl + '/sse/chat?token=' + encodeURIComponent(this.token);
        let resolved = false;

        const resolve = () => {
            if (resolved) return;
            resolved = true;
            if (this._earlySse) { this._earlySse.close(); this._earlySse = null; }
            this._showHome(null);
        };

        try {
            this._earlySse = new EventSource(url);
            this._earlySse.onmessage = (event) => {
                try {
                    const d = JSON.parse(event.data);
                    if (d.type === 'auth_success') {
                        this.topics = d.topics || [];
                        resolve();
                    }
                } catch (_) {}
            };
            this._earlySse.onerror = () => resolve();
        } catch (_) {
            resolve();
        }

        setTimeout(resolve, 5000);
    }

    // ── Chat screen ───────────────────────────────────────────────────────────

    _startChat(topicId) {
        this.state        = 'CHATTING';
        this.currentTopic = topicId;

        this._chatId    = this._generateChatId();
        this._sessionId = null;
        try { localStorage.setItem('voltimax_chat_id', this._chatId); } catch (e) {}

        // Show chat ID in header
        const chatIdEl = document.querySelector('.voltimax-chat-widget__chat-id');
        if (chatIdEl) { chatIdEl.textContent = this._chatId; chatIdEl.style.display = ''; }

        // Show chat-only header buttons
        const newChatBtn = document.querySelector('.voltimax-chat-widget__new-chat');
        if (newChatBtn) newChatBtn.style.display = '';
        const copyBtn = document.querySelector('.voltimax-chat-widget__copy');
        if (copyBtn) copyBtn.style.display = '';

        const body = document.querySelector('.voltimax-chat-widget__body');
        body.textContent = '';

        const chatWindow = document.createElement('div');
        chatWindow.className = 'voltimax-chat-window';

        // Messages wrapper — holds the scroll button via position:absolute
        const messagesWrap = document.createElement('div');
        messagesWrap.className = 'voltimax-chat-messages-wrap';

        const messages = document.createElement('div');
        messages.className = 'voltimax-chat-window__messages';
        messages.setAttribute('role', 'log');
        messages.setAttribute('aria-live', 'polite');
        messages.setAttribute('aria-label', 'Chat-Verlauf');
        messagesWrap.appendChild(messages);

        // Scroll-to-bottom button
        const scrollBtn = document.createElement('button');
        scrollBtn.className = 'voltimax-chat-scroll-btn';
        scrollBtn.setAttribute('aria-label', 'Nach unten scrollen');
        // Safe: hardcoded SVG
        scrollBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
        scrollBtn.style.display = 'none';
        scrollBtn.addEventListener('click', () => { messages.scrollTop = messages.scrollHeight; });
        messagesWrap.appendChild(scrollBtn);

        messages.addEventListener('scroll', () => {
            const atBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 60;
            scrollBtn.style.display = atBottom ? 'none' : '';
        });

        chatWindow.appendChild(messagesWrap);

        // Quick reply chips (skip if we have pending sub-cards -- they will be shown instead)
        if (!this._pendingSubCards) {
            const quickReplies = this._getQuickReplies(topicId);
            if (quickReplies.length) {
                const qrRow = document.createElement('div');
                qrRow.className = 'voltimax-chat-quickreplies';
                quickReplies.forEach(text => {
                    const chip = document.createElement('button');
                    chip.className = 'voltimax-chat-quickreply';
                    chip.textContent = text;
                    chip.addEventListener('click', () => { qrRow.remove(); this._sendQuickReply(text); });
                    qrRow.appendChild(chip);
                });
                chatWindow.appendChild(qrRow);
            }
        }

        const inputArea = document.createElement('div');
        inputArea.className = 'voltimax-chat-window__input-area';

        const textarea = document.createElement('textarea');
        textarea.className = 'voltimax-chat-window__input form-control';
        textarea.placeholder = 'Schreib eine Nachricht …';
        textarea.rows = 1;

        let qrRemoved = false;
        textarea.addEventListener('input', () => {
            // Auto-grow up to 4 rows
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 96) + 'px';
            // Remove quick replies on first keystroke
            if (!qrRemoved) {
                qrRemoved = true;
                const qr = chatWindow.querySelector('.voltimax-chat-quickreplies');
                if (qr) qr.remove();
            }
        });

        inputArea.appendChild(textarea);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'voltimax-chat-window__send btn btn-primary';
        sendBtn.setAttribute('aria-label', 'Senden');
        // Safe: hardcoded SVG
        sendBtn.innerHTML = '<span class="vtx-orb vtx-orb--send" aria-hidden="true"><span class="vtx-orb__petal vtx-orb__petal--r"></span><span class="vtx-orb__petal vtx-orb__petal--b"></span><span class="vtx-orb__petal vtx-orb__petal--c"></span><span class="vtx-orb__flare"></span></span>';
        inputArea.appendChild(sendBtn);

        chatWindow.appendChild(inputArea);
        body.appendChild(chatWindow);

        this._connectToServerB(topicId);

        sendBtn.addEventListener('click', () => this._sendMessage(textarea));
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(textarea); }
        });
    }

    _buildChatUI(topicId) {
        // Build chat DOM without reconnecting WebSocket (already connected)
        this.state = 'CHATTING';
        this.currentTopic = topicId;

        if (!this._chatId) {
            this._chatId = this._generateChatId();
            try { localStorage.setItem('voltimax_chat_id', this._chatId); } catch (e) {}
        }

        const chatIdEl = document.querySelector('.voltimax-chat-widget__chat-id');
        if (chatIdEl) { chatIdEl.textContent = this._chatId; chatIdEl.style.display = ''; }
        const newChatBtn = document.querySelector('.voltimax-chat-widget__new-chat');
        if (newChatBtn) newChatBtn.style.display = '';
        const copyBtn = document.querySelector('.voltimax-chat-widget__copy');
        if (copyBtn) copyBtn.style.display = '';

        const body = document.querySelector('.voltimax-chat-widget__body');
        body.textContent = '';

        const chatWindow = document.createElement('div');
        chatWindow.className = 'voltimax-chat-window';

        const messagesWrap = document.createElement('div');
        messagesWrap.className = 'voltimax-chat-messages-wrap';

        const messages = document.createElement('div');
        messages.className = 'voltimax-chat-window__messages';
        messages.setAttribute('role', 'log');
        messages.setAttribute('aria-live', 'polite');
        messages.setAttribute('aria-label', 'Chat-Verlauf');
        messagesWrap.appendChild(messages);

        const scrollBtn = document.createElement('button');
        scrollBtn.className = 'voltimax-chat-scroll-btn';
        scrollBtn.setAttribute('aria-label', 'Nach unten scrollen');
        scrollBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
        scrollBtn.style.display = 'none';
        scrollBtn.addEventListener('click', () => { messages.scrollTop = messages.scrollHeight; });
        messagesWrap.appendChild(scrollBtn);

        messages.addEventListener('scroll', () => {
            const atBottom = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 60;
            scrollBtn.style.display = atBottom ? 'none' : '';
        });

        chatWindow.appendChild(messagesWrap);

        const inputArea = document.createElement('div');
        inputArea.className = 'voltimax-chat-window__input-area';

        const textarea = document.createElement('textarea');
        textarea.className = 'voltimax-chat-window__input form-control';
        textarea.placeholder = 'Schreib eine Nachricht …';
        textarea.rows = 1;
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 96) + 'px';
        });
        inputArea.appendChild(textarea);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'voltimax-chat-window__send btn btn-primary';
        sendBtn.setAttribute('aria-label', 'Senden');
        sendBtn.innerHTML = '<span class="vtx-orb vtx-orb--send" aria-hidden="true"><span class="vtx-orb__petal vtx-orb__petal--r"></span><span class="vtx-orb__petal vtx-orb__petal--b"></span><span class="vtx-orb__petal vtx-orb__petal--c"></span><span class="vtx-orb__flare"></span></span>';
        inputArea.appendChild(sendBtn);

        chatWindow.appendChild(inputArea);
        body.appendChild(chatWindow);

        sendBtn.addEventListener('click', () => this._sendMessage(textarea));
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this._sendMessage(textarea); }
        });
    }

    _startNewChat() {
        if (this._sessionId) {
            this._callServerB('/chat/end', { session_id: this._sessionId });
        }
        this._chatId        = null;
        this._sessionId     = null;
        this._streamingRow  = null;
        this._streamingRaw  = '';
        this._pendingSubCards = null;
        this._pendingFreeText = null;
        this._expandedTopicId = null;
        try { localStorage.removeItem('voltimax_chat_id'); } catch (e) {}
        if (this.ws)  { this.ws.close();  this.ws  = null; }
        if (this.sse) { this.sse.close(); this.sse = null; }
        if (this._earlySse) { this._earlySse.close(); this._earlySse = null; }
        this._showHome(null);
    }

    _copyTranscript() {
        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;

        const lines = [];
        messages.querySelectorAll('.voltimax-chat-message').forEach(msg => {
            const sender = msg.classList.contains('voltimax-chat-message--user') ? 'Sie' : 'AI';
            // Exclude timestamp text from content
            const cloned = msg.cloneNode(true);
            const clonedTime = cloned.querySelector('.voltimax-chat-message__time');
            if (clonedTime) clonedTime.remove();
            const text = cloned.textContent.trim().replace(/\s+/g, ' ');
            if (text) lines.push(sender + ': ' + text);
        });

        if (!lines.length) return;

        navigator.clipboard.writeText(lines.join('\n\n')).then(() => {
            const btn = document.querySelector('.voltimax-chat-widget__copy');
            if (!btn) return;
            const orig = btn.innerHTML;
            // Safe: hardcoded SVG
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => { btn.innerHTML = orig; }, 1800);
        });
    }

    // ── Quick replies ─────────────────────────────────────────────────────────

    _getQuickReplies(topicId) {
        const map = {
            order_status:         ['Where is my order?', 'Track shipment', 'Report delay'],
            returns:              ['Start a return', 'Refund status', 'Return label'],
            order_issue:          ['Wrong item received', 'Item damaged', 'Item missing'],
            product_help:         ['Compare products', 'Technical question', 'Which model fits?'],
            stock:                ['Is this in stock?', 'When back in stock?', 'Suggest alternative'],
            compatibility:        ['Find battery for my car', 'Does this fit?', 'Enter vehicle'],
            delivery_time:        ['How long is delivery?', 'Express possible?', 'Order today?'],
            shipping_costs:       ['Calculate shipping', 'Free shipping threshold?'],
            express_delivery:     ['Express delivery', 'Same-day available?'],
            payment:              ['Payment methods?', 'Invoice payment', 'Installments?'],
            address:              ['Change address', 'Add new address'],
            invoice:              ['Request invoice', 'Download invoice'],
            faq:                  ['Warranty info', 'Return policy', 'Payment terms'],
            complaint:            ['Submit complaint', 'Give feedback'],
        };
        return (map[topicId] || []).slice(0, 3);
    }

    _sendQuickReply(text) {
        this._addMessage('user', text);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'message', content: text }));
            this._showTypingIndicator();
        }
        // Chip clicks trigger an AI response too — same lock as typed messages
        this._lockInput();
    }

    // ── Server B connection ───────────────────────────────────────────────────

    _connectToServerB(topicId) {
        if (!this.config.serverBUrl || !this.token) return;

        // This tab is about to hold the socket — other tabs yield via storage event
        this._claimConnection();
        this._currentTopicId = topicId;
        const wsUrl = this.config.serverBUrl.replace(/^http/, 'ws') + '/ws/chat';
        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.onopen = () => {
                this._reconnectAttempts = 0;
                clearTimeout(this._reconnectTimer);
                this._hideReconnectBanner();
                this.ws.send(JSON.stringify({ type: 'auth', token: this.token, chat_id: this._chatId || '' }));
                this._pendingTopic = topicId;
                this._setConnectionStatus('ws');
            };
            this.ws.onmessage = (event) => this._onMessage(event);
            this.ws.onerror   = () => this._fallbackToSSE(topicId);
            this.ws.onclose   = () => this._onDisconnect();
        } catch (e) {
            this._fallbackToSSE(topicId);
        }
    }

    _fallbackToSSE(topicId) {
        const sseUrl = this.config.serverBUrl + '/sse/chat?token='
            + encodeURIComponent(this.token) + '&topic=' + encodeURIComponent(topicId);
        try {
            this.sse = new EventSource(sseUrl);
            this.sse.onmessage = (event) => this._onMessage(event);
            this.sse.onerror   = () => this._onDisconnect();
            this._setConnectionStatus('sse');
        } catch (e) {}
    }

    _onMessage(event) {
        var data;
        try { data = JSON.parse(event.data); } catch (e) { return; }

        // Orb policy: ANY content-bearing reply (text, stream, every card
        // type — info, form, confirmation, choices, prompts — and errors)
        // dismisses the docked orb and restores the input field. Only pure
        // status signals ('typing', sounds, suggestion refreshes, auth)
        // keep the orb thinking. This guarantees cards that ask for input
        // (e.g. the battery-finder cascade) always arrive with the input
        // bar back and never race a hidden composer.
        // Streaming does NOT dismiss: 'stream_start' fires ~seconds before
        // the first token (backend announces the stream, then fetches shop
        // data), and chunks are still mid-generation. The orb keeps thinking
        // centered until stream_end or a full reply/card arrives.
        if (this._typingEl
            && data.type !== 'typing'
            && data.type !== 'play_sound'
            && data.type !== 'suggestions'
            && data.type !== 'auth_success'
            && data.type !== 'stream_start'
            && data.type !== 'stream_chunk') {
            this._hideTypingIndicator();
        }

        // Resolve a pending verification indicator: an incoming card means
        // success (green flash); a plain reply or error means the flow
        // answered differently, so the indicator leaves quietly.
        if (this._verifyingEl) {
            if (data.type === 'ai_card' || data.type === 'info_card') {
                this._resolveVerifyingCard(true);
            } else if (data.type === 'message' || data.type === 'stream_chunk' || data.type === 'error') {
                this._resolveVerifyingCard(false);
            }
        }

        if (data.type === 'auth_success') {
            // WebSocket auth_success includes session_id; SSE early auth does not
            if (data.session_id) {
                this._sessionId = data.session_id;
                // Link the chat_id to the WebSocket session
                if (this._chatId) {
                    this._callServerB('/chat/session/start', {
                        chat_id:    this._chatId,
                        topic_id:   this.currentTopic || 'general',
                        session_id: this._sessionId,
                    });
                    this._pushGA4('groot_chat_started', {
                        groot_session: this._chatId,
                        topic: this.currentTopic || 'general',
                    });
                }
            }

            // Render context-aware suggestions from server (replace defaults on home screen)
            if (data.suggestions && data.suggestions.length) {
                this._serverSuggestions = data.suggestions;
                // Update home screen suggestions if still visible
                if (this._homeSuggestionsContainer && this._homeNameInput) {
                    const inputEl = document.querySelector('.vtx-home__input-row input');
                    if (inputEl) {
                        this._renderHomeSuggestions(
                            this._homeSuggestionsContainer, data.suggestions, inputEl,
                            () => { inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); }
                        );
                    }
                }
            }

            // Legacy: if a topic was explicitly selected, send select_topic
            if (this._pendingTopic && this._pendingTopic !== 'general' && this.ws && this.ws.readyState === WebSocket.OPEN) {
                this._skipNextGreeting = !!this._pendingFreeText;
                this.ws.send(JSON.stringify({
                    type:     'select_topic',
                    topic_id: this._pendingTopic,
                    chat_id:  this._chatId,
                }));
                this._pendingTopic = null;
            }

            // Send pending free-text message directly (no topic selection needed)
            if (this._pendingFreeText) {
                const text = this._pendingFreeText;
                this._pendingFreeText = null;
                this._pendingTopic = null;
                setTimeout(() => {
                    this._addMessage('user', text);
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(JSON.stringify({ type: 'message', content: text }));
                        this._showTypingIndicator();
                    }
                    // Show server suggestions below the chat input
                    if (this._serverSuggestions) {
                        this._renderSuggestions(this._serverSuggestions);
                        this._serverSuggestions = null;
                    }
                }, 100);
            }

            // Resend interrupted message after session restore
            if (this._pendingResend) {
                const resendText = this._pendingResend;
                this._pendingResend = null;
                this._skipNextGreeting = true;
                setTimeout(() => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this._showTypingIndicator();
                        this.ws.send(JSON.stringify({ type: 'message', content: resendText }));
                        this._showTypingIndicator();
                    }
                }, 500);
            }
        } else if (data.type === 'stream_chunk') {
            // Render tokens live into a streaming bubble (progressive reveal)
            this._streamingRaw = (this._streamingRaw || '') + data.content;
            this._renderStreaming();
        } else if (data.type === 'stream_end') {
            this._hideTypingIndicator();

            const aiMessageId = data.message_id || null;
            const fullText = this._streamingRaw || '';
            const live = this._streamingRow;
            this._streamingRaw = '';
            this._streamingRow = null;

            if (!aiMessageId) {
                // No message_id = discard signal (card response coming via ai_card
                // type) — remove the live bubble, the card replaces it
                if (live) live.row.remove();
            } else if (live) {
                this._finalizeStreamingRow(live, fullText, aiMessageId);
                if (this._minimized) this._incrementBadge();
            } else if (fullText) {
                // No chunks were rendered (chat UI not built yet) — add at once
                this._addMessage('ai', fullText, aiMessageId);
                if (this._minimized) this._incrementBadge();
            }
            this._unlockInput();

            // Render sub-card chips after the first bot message if pending
            if (this._pendingSubCards) {
                const parentTopic = this._pendingSubCards;
                this._pendingSubCards = null;
                this._renderSubCardChips(parentTopic);
            }
        } else if (data.type === 'message') {
            // Clear typing indicator
            this._hideTypingIndicator();
            // Skip the topic greeting if user typed free-text (their message is already queued)
            if (this._skipNextGreeting) {
                this._skipNextGreeting = false;
                // Don't show this greeting — the AI will respond to the user's message instead
            } else {
                this._addMessage('ai', data.content, data.message_id || null);
            }
            this._unlockInput();
            // Render sub-card chips after the first bot message if pending
            if (this._pendingSubCards) {
                const parentTopic = this._pendingSubCards;
                this._pendingSubCards = null;
                this._renderSubCardChips(parentTopic);
            }
        } else if (data.type === 'ai_card') {
            // AI intro text + card as one message — uses same structure as _addMessage('ai')
            this._hideTypingIndicator();
            var messages = document.querySelector('.voltimax-chat-window__messages');
            if (!messages) {
                this._buildChatUI(this.currentTopic || 'general');
                messages = document.querySelector('.voltimax-chat-window__messages');
            }
            if (messages) {
                var aiMessageId = data.message_id || this._generateId();

                if (!this._restoring) {
                    this._history.push({ kind: 'ai_card', text: data.content || '', card: data.info_card || null });
                    if (this._history.length > 60) this._history.shift();
                }

                // Same row structure as _addMessage: avatar | rowBody
                var row = document.createElement('div');
                row.className = 'voltimax-chat-ai-row';
                this._applyAiGrouping(row, messages);

                var avatarEl = this._buildAvatarEl();

                var rowBody = document.createElement('div');
                rowBody.className = 'voltimax-chat-ai-row__body';

                // Name label
                var nameLabel = document.createElement('div');
                nameLabel.className = 'voltimax-chat-ai-row__name';
                nameLabel.textContent = 'Groot';
                rowBody.appendChild(nameLabel);

                // Single message bubble containing text + card
                var msg = document.createElement('div');
                msg.className = 'voltimax-chat-message voltimax-chat-message--ai';
                msg.dataset.messageId = aiMessageId;
                msg.style.cssText = 'padding:0;overflow:hidden;';

                // Text inside the bubble
                if (data.content) {
                    var textWrap = document.createElement('div');
                    textWrap.style.cssText = 'padding:10px 14px 8px;';
                    textWrap.appendChild(this._buildMessageNodes(data.content));
                    msg.appendChild(textWrap);
                }

                // Card inside the same bubble
                if (data.info_card) {
                    var cardEl = this._buildInfoCardDOM(data.info_card);
                    if (cardEl) {
                        cardEl.style.cssText += ';margin:0;border-radius:0;border-left:none;border-right:none;border-bottom:none;';
                        msg.appendChild(cardEl);
                    }
                }

                // Confirmation form inside the same bubble
                if (data.confirmation) {
                    var confirmEl = this._buildConfirmationDOM(data.confirmation);
                    if (confirmEl) {
                        confirmEl.style.cssText += ';margin:0;border-radius:0;border-left:none;border-right:none;border-bottom:none;';
                        msg.appendChild(confirmEl);
                    }
                }

                // Timestamp at the bottom
                var timeEl = document.createElement('span');
                timeEl.className = 'voltimax-chat-message__time';
                timeEl.style.cssText = 'padding:0 14px 8px;display:block;';
                timeEl.textContent = this._formatTime(new Date());
                msg.appendChild(timeEl);

                rowBody.appendChild(msg);

                // Feedback row
                rowBody.appendChild(this._buildFeedbackRow(aiMessageId));

                row.appendChild(avatarEl);
                row.appendChild(rowBody);
                messages.appendChild(row);
                if (this._restoring) {
                    messages.scrollTop = messages.scrollHeight;
                } else {
                    this._scrollMessageIntoView(messages, row);
                }
            }
            if (this._minimized) this._incrementBadge();
            this._unlockInput();
            this._saveSession();
        } else if (data.type === 'typing') {
            this._showTypingIndicator();
        } else if (data.type === 'escalation') {
            this._showEscalation(data);
            this._unlockInput();
        } else if (data.type === 'play_sound') {
            this._playSound(data.message);
        } else if (data.type === 'confirmation_request' && data.confirmation) {
            this._showConfirmationCard(data.confirmation);
            this._unlockInput();
        } else if (data.type === 'choices' && data.choices) {
            this._renderChoices(data.message || '', data.choices);
            this._unlockInput();
        } else if (data.type === 'input_prompt' && data.input_prompt) {
            this._renderInputPrompt(data.input_prompt);
            this._unlockInput();
        } else if (data.type === 'info_card' && data.info_card) {
            this._renderInfoCard(data.info_card);
            this._unlockInput();
        } else if (data.type === 'suggestions' && data.suggestions) {
            this._renderSuggestions(data.suggestions);
        } else if (data.type === 'session_closed') {
            // Server closed the session (idle timeout, escalation, etc.)
            this._sessionClosed = true;
            this._reconnectAttempts = 999; // prevent auto-reconnect
            this._lockChatClosed();
            // Idle closes stay resumable for a while (server enforces the window)
            this._renderClosedBanner(data.message === 'idle_timeout');
        } else if (data.type === 'session_resumable') {
            // Reconnected to an idle-closed session within the resume window
            if (this._resumeRequested && this.ws && this.ws.readyState === WebSocket.OPEN) {
                // Customer already clicked "Weiterführen" — resume immediately
                this.ws.send(JSON.stringify({ type: 'resume_session' }));
            } else {
                // Returning visitor: locked chat + explicit choice
                this._sessionClosed = true;
                this._lockChatClosed();
                this._renderClosedBanner(true);
            }
        } else if (data.type === 'session_resumed') {
            this._resumeRequested = false;
            this._sessionClosed = false;
            this._reconnectAttempts = 0;
            this._unlockChatClosed();
        } else if (data.type === 'session_expired') {
            // Resume window is over — the restored transcript is read-only
            // history now; only a new chat remains ("closed forever").
            if (this._history && this._history.length) {
                this._resumeRequested = false;
                this._sessionClosed = true;
                this._lockChatClosed();
                this._renderClosedBanner(false);
            }
        } else if (data.type === 'confirmation_done') {
            // Ticket created — turn the submitting form into a receipt with the
            // real ticket number
            if (this._confirmAckTimer) { clearTimeout(this._confirmAckTimer); this._confirmAckTimer = null; }
            if (this._pendingConfirmCard) {
                var tidSuffix = data.ticket_id ? ' — Ticket #' + data.ticket_id : '';
                this._finalizeConfirmCard(this._pendingConfirmCard, '✓ Anfrage übermittelt' + tidSuffix, true);
                this._pendingConfirmCard = null;
            }
        } else if (data.type === 'error') {
            var errMsg = data.message || 'An error occurred.';
            // Now that the lock really disables the field, an error must
            // always release it — otherwise the customer is frozen for 30s
            this._unlockInput();

            // Ticket creation failed — re-open the submitting form instead of
            // faking a receipt
            if (this._confirmAckTimer) { clearTimeout(this._confirmAckTimer); this._confirmAckTimer = null; }
            if (this._pendingConfirmCard) {
                var pc = this._pendingConfirmCard;
                this._pendingConfirmCard = null;
                if (pc.dataset.state === 'submitting') {
                    pc.dataset.state = 'live';
                    pc.querySelectorAll('input, textarea, select, button').forEach(function(el) { el.disabled = false; });
                    var retryBtn = pc.querySelector('.voltimax-chat-confirm__btn--confirm');
                    if (retryBtn) retryBtn.textContent = 'Bestätigen →';
                }
            }

            // Auth/token errors: stop reconnecting, clear stale session, go back to home
            if (errMsg.indexOf('401') !== -1 || errMsg.indexOf('Authentication') !== -1 || errMsg.indexOf('Token') !== -1) {
                this._sessionClosed = true; // prevent reconnect loop
                clearTimeout(this._reconnectTimer);
                if (this.ws) { this.ws.close(); this.ws = null; }
                this._clearSession();
                this.token = null;
                this.state = 'OPEN';
                this._showHome(null);
                return;
            }

            this._addMessage('ai', errMsg);
        }
    }

    _onDisconnect() {
        this._setConnectionStatus('disconnected');

        // Don't reconnect if session was explicitly closed (idle timeout, etc.)
        // or if another tab took over the connection
        if (this._sessionClosed || this._yielded) return;

        // Auto-reconnect with exponential backoff (C3)
        if (this.state !== 'CHATTING' || !this._currentTopicId) return;
        const MAX_ATTEMPTS = 5;
        if (this._reconnectAttempts >= MAX_ATTEMPTS) {
            // Don't give up silently — the customer would type into a dead chat.
            this._showReconnectBanner();
            return;
        }

        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
        this._reconnectAttempts++;
        this._reconnectTimer = setTimeout(() => {
            if (this.state === 'CHATTING') {
                this._connectToServerB(this._currentTopicId);
            }
        }, delay);
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    _showReconnectBanner() {
        if (document.querySelector('.voltimax-chat-reconnect')) return;
        var messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;
        var banner = document.createElement('div');
        banner.className = 'voltimax-chat-reconnect';
        banner.setAttribute('role', 'alert');
        var txt = document.createElement('span');
        txt.textContent = 'Verbindung unterbrochen';
        banner.appendChild(txt);
        var self = this;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'Erneut verbinden';
        btn.addEventListener('click', function() {
            btn.disabled = true;
            txt.textContent = 'Verbinde\u2026';
            self._reconnectAttempts = 0;
            self._connectToServerB(self._currentTopicId);
        });
        banner.appendChild(btn);
        messages.appendChild(banner);
        messages.scrollTop = messages.scrollHeight;
        var input = this._chatInputEl();
        if (input) { input.disabled = true; input.placeholder = 'Verbindung unterbrochen'; }
    }

    _hideReconnectBanner() {
        var banner = document.querySelector('.voltimax-chat-reconnect');
        if (banner) banner.remove();
        var input = this._chatInputEl();
        if (input && !this._inputLocked) { input.disabled = false; input.placeholder = 'Schreib eine Nachricht …'; }
    }

    // The textarea CARRIES the class (it is not a wrapper) — the old selector
    // '.voltimax-chat-window__input textarea' matched nothing, so the input
    // was never actually disabled while Groot responded.
    _chatInputEl() {
        return document.querySelector('.voltimax-chat-window__input');
    }

    _chatSendBtnEl() {
        return document.querySelector('.voltimax-chat-window__send');
    }

    // ── Closed-session state (idle timeout) ─────────────────────────────────
    // The chat locks visibly; within the server's resume window the customer
    // chooses "Weiterführen" (same session, full context) or "Neuen Chat
    // starten". After the window only a new chat is offered.

    _lockChatClosed() {
        this._hideTypingIndicator();
        var input = this._chatInputEl();
        if (input) { input.disabled = true; input.placeholder = 'Sitzung beendet'; input.value = ''; }
        var sendBtn = this._chatSendBtnEl();
        if (sendBtn) sendBtn.disabled = true;
        var win = document.querySelector('.voltimax-chat-window');
        if (win) win.classList.add('voltimax-chat-window--closed');
    }

    _unlockChatClosed() {
        this._removeClosedBanner();
        var win = document.querySelector('.voltimax-chat-window');
        if (win) win.classList.remove('voltimax-chat-window--closed');
        var input = this._chatInputEl();
        if (input) { input.disabled = false; input.placeholder = 'Schreib eine Nachricht …'; input.focus(); }
        var sendBtn = this._chatSendBtnEl();
        if (sendBtn) sendBtn.disabled = false;
    }

    _removeClosedBanner() {
        var old = document.querySelector('.vtx-closed-banner');
        if (old) old.remove();
    }

    _renderClosedBanner(resumable) {
        this._removeClosedBanner();
        var messagesEl = document.querySelector('.voltimax-chat-window__messages');
        if (!messagesEl) return;

        var banner = document.createElement('div');
        banner.className = 'vtx-closed-banner';
        banner.innerHTML =
            '<div class="vtx-closed-banner__title">Diese Sitzung wurde beendet</div>'
            + '<div class="vtx-closed-banner__actions">'
            + (resumable ? '<button type="button" class="vtx-closed-banner__btn vtx-closed-banner__btn--resume">Weiterführen</button>' : '')
            + '<button type="button" class="vtx-closed-banner__btn vtx-closed-banner__btn--new">Neuen Chat starten</button>'
            + '</div>';
        messagesEl.appendChild(banner);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        var resumeBtn = banner.querySelector('.vtx-closed-banner__btn--resume');
        if (resumeBtn) {
            resumeBtn.addEventListener('click', () => {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    // Socket still up (returning visitor) — resume directly
                    this.ws.send(JSON.stringify({ type: 'resume_session' }));
                } else {
                    // Live idle close ended the socket — reconnect, then the
                    // session_resumable handler auto-sends resume_session
                    this._resumeRequested = true;
                    this._sessionClosed = false;
                    this._reconnectAttempts = 0;
                    this._connectToServerB(this._currentTopicId || 'general');
                }
            });
        }
        banner.querySelector('.vtx-closed-banner__btn--new').addEventListener('click', () => {
            this._sessionClosed = false;
            this._resumeRequested = false;
            this._reconnectAttempts = 0;
            this._resetChat();
        });
    }

    _sendMessage(input) {
        const text = input.value.trim();
        if (!text || this._inputLocked || this._sessionClosed) return;
        input.value = '';
        input.style.height = 'auto'; // reset auto-grow

        const qr = document.querySelector('.voltimax-chat-quickreplies');
        if (qr) qr.remove();

        const messageId = this._generateId();
        this._addMessage('user', text, messageId);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'message', content: text }));
            this._showTypingIndicator();
        }

        // Lock input while AI is processing
        this._lockInput();
    }

    _lockInput() {
        this._inputLocked = true;
        var input = this._chatInputEl();
        var sendBtn = this._chatSendBtnEl();
        if (input) { input.disabled = true; input.placeholder = 'Groot denkt nach...'; }
        if (sendBtn) sendBtn.disabled = true;
        // Safety timeout — unlock after 30s if no response arrives
        if (this._lockTimer) clearTimeout(this._lockTimer);
        this._lockTimer = setTimeout(() => this._unlockInput(), 30000);
    }

    _unlockInput() {
        this._hideTypingIndicator();
        if (this._sessionClosed) return; // a stray lock timer must not reopen a closed chat
        if (!this._inputLocked) return;
        this._inputLocked = false;
        if (this._lockTimer) { clearTimeout(this._lockTimer); this._lockTimer = null; }
        var input = this._chatInputEl();
        var sendBtn = this._chatSendBtnEl();
        if (input) { input.disabled = false; input.placeholder = 'Schreib eine Nachricht …'; input.focus(); }
        if (sendBtn) sendBtn.disabled = false;
    }

    // ── Live streaming ────────────────────────────────────────────────────────
    // stream_chunk tokens render progressively into a live bubble with the same
    // row structure as _addMessage. stream_end finalizes it in place — or
    // removes it when the backend discards the stream (card response follows).

    _renderStreaming() {
        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;

        if (!this._streamingRow) {
            // A docked orb stays centered while tokens stream (it leaves on
            // stream_end); only a legacy in-flow indicator must make way.
            if (this._typingEl && !this._typingEl.classList.contains('voltimax-chat-typing--dock')) {
                this._hideTypingIndicator();
            }

            // The AI started answering — mark the last user message as read
            if (this._lastUserStatusEl) {
                this._markLastUserRead();
                this._lastUserStatusEl = null;
            }

            const row = document.createElement('div');
            row.className = 'voltimax-chat-ai-row';
            this._applyAiGrouping(row, messages);

            const rowBody = document.createElement('div');
            rowBody.className = 'voltimax-chat-ai-row__body';

            const nameLabel = document.createElement('div');
            nameLabel.className = 'voltimax-chat-ai-row__name';
            nameLabel.textContent = 'Groot';
            rowBody.appendChild(nameLabel);

            const msg = document.createElement('div');
            msg.className = 'voltimax-chat-message voltimax-chat-message--ai is-streaming';

            const textWrap = document.createElement('div');
            msg.appendChild(textWrap);

            rowBody.appendChild(msg);
            row.appendChild(this._buildAvatarEl());
            row.appendChild(rowBody);
            messages.appendChild(row);
            this._streamingRow = { row, msg, textWrap };
        }

        // Re-render the accumulated text (messages are small; this is cheap)
        const wrap = this._streamingRow.textWrap;
        const followStream = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 140;
        wrap.textContent = '';
        wrap.appendChild(this._buildMessageNodes(this._streamingRaw || ''));

        // Blinking cursor at the end of the last text block
        let lastBlock = wrap.lastElementChild;
        if (lastBlock && (lastBlock.tagName === 'UL' || lastBlock.tagName === 'OL')) {
            lastBlock = lastBlock.lastElementChild || lastBlock;
        }
        const cursor = document.createElement('span');
        cursor.className = 'vtx-stream-cursor';
        (lastBlock || wrap).appendChild(cursor);

        // Follow the stream only while the user is near the bottom
        if (followStream) messages.scrollTop = messages.scrollHeight;
    }

    _finalizeStreamingRow(live, fullText, aiMessageId) {
        const cursor = live.msg.querySelector('.vtx-stream-cursor');
        if (cursor) cursor.remove();
        live.msg.classList.remove('is-streaming');
        live.msg.dataset.messageId = aiMessageId;

        const timeEl = document.createElement('span');
        timeEl.className = 'voltimax-chat-message__time';
        timeEl.textContent = this._formatTime(new Date());
        live.msg.appendChild(timeEl);

        const rowBody = live.msg.parentElement;
        if (rowBody) rowBody.appendChild(this._buildFeedbackRow(aiMessageId));

        if (!this._restoring && fullText) {
            this._history.push({ kind: 'ai', text: fullText });
            if (this._history.length > 60) this._history.shift();
        }
        this._saveSession();
    }

    // Consecutive AI rows: show avatar + name only on the first of a burst
    _applyAiGrouping(row, messages) {
        const last = messages.lastElementChild;
        if (last && last.classList && last.classList.contains('voltimax-chat-ai-row')) {
            row.classList.add('voltimax-chat-ai-row--grouped');
        }
    }

    // Long answers anchor to their top so the customer reads from the start;
    // short ones keep the classic pin-to-bottom.
    _scrollMessageIntoView(messages, row) {
        if (row.offsetHeight > messages.clientHeight * 0.7) {
            const top = row.getBoundingClientRect().top
                - messages.getBoundingClientRect().top + messages.scrollTop;
            messages.scrollTop = Math.max(0, top - 8);
        } else {
            messages.scrollTop = messages.scrollHeight;
        }
    }

    _addMessage(sender, content, messageId = null) {
        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return null;

        // Record for session restore (structured — no innerHTML round-trips)
        if (!this._restoring && content) {
            this._history.push({ kind: sender === 'user' ? 'user' : 'ai', text: content });
            if (this._history.length > 60) this._history.shift();
        }

        // Finalize any active streaming bubble
        const streaming = messages.querySelector('.is-streaming');
        if (streaming) streaming.classList.remove('is-streaming');

        if (sender === 'ai') {
            // Update last user message status to "Read"
            if (this._lastUserStatusEl) {
                this._markLastUserRead();
                this._lastUserStatusEl = null;
            }

            const aiMessageId = messageId || this._generateId();

            // Row structure: avatar | [name + bubble + feedback]
            const row = document.createElement('div');
            row.className = 'voltimax-chat-ai-row';
            this._applyAiGrouping(row, messages);

            const avatarEl = this._buildAvatarEl();

            const rowBody = document.createElement('div');
            rowBody.className = 'voltimax-chat-ai-row__body';

            // Name label
            const nameLabel = document.createElement('div');
            nameLabel.className = 'voltimax-chat-ai-row__name';
            nameLabel.textContent = 'Groot';
            rowBody.appendChild(nameLabel);

            const msg = document.createElement('div');
            msg.className = 'voltimax-chat-message voltimax-chat-message--ai';
            msg.appendChild(this._buildMessageNodes(content));

            const timeEl = document.createElement('span');
            timeEl.className = 'voltimax-chat-message__time';
            timeEl.textContent = this._formatTime(new Date());
            msg.appendChild(timeEl);

            rowBody.appendChild(msg);
            rowBody.appendChild(this._buildFeedbackRow(aiMessageId));

            row.appendChild(avatarEl);
            row.appendChild(rowBody);
            messages.appendChild(row);
            if (this._restoring) {
                messages.scrollTop = messages.scrollHeight;
            } else {
                this._scrollMessageIntoView(messages, row);
            }

            // No badge/save during history replay (restore or cross-tab mirror)
            if (this._minimized && !this._restoring) this._incrementBadge();
            if (!this._restoring) this._saveSession();

            return msg;
        } else {
            const wrapper = document.createElement('div');
            wrapper.className = 'voltimax-chat-user-row';
            wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;';

            // Customer name — only on the first message of a burst
            const prevIsUser = messages.lastElementChild
                && messages.lastElementChild.classList
                && messages.lastElementChild.classList.contains('voltimax-chat-user-row');
            const customerName = (this.customerContext && this.customerContext.name) || '';
            if (customerName && !prevIsUser) {
                const nameEl = document.createElement('div');
                nameEl.style.cssText = 'font-size:11px;font-weight:700;color:var(--vtx-primary, #8f5a2e);padding-right:4px;margin-bottom:2px;';
                nameEl.textContent = customerName.split(' ')[0];
                wrapper.appendChild(nameEl);
            }

            const msg = document.createElement('div');
            msg.className = 'voltimax-chat-message voltimax-chat-message--user';
            msg.textContent = content;

            const timeEl = document.createElement('span');
            timeEl.className = 'voltimax-chat-message__time';
            timeEl.textContent = this._formatTime(new Date());

            // Delivery status: one check when sent, double green check once read
            const statusEl = document.createElement('span');
            statusEl.className = 'voltimax-chat-message__status';
            statusEl.innerHTML = '<svg class="vtx-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><svg class="vtx-check vtx-check--second" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg><span class="vtx-status-label">Gesendet</span>';
            // Time and checks sit side by side in one meta row
            const metaEl = document.createElement('span');
            metaEl.className = 'voltimax-chat-message__meta';
            metaEl.appendChild(timeEl);
            metaEl.appendChild(statusEl);
            msg.appendChild(metaEl);
            this._lastUserStatusEl = statusEl;

            wrapper.appendChild(msg);
            messages.appendChild(wrapper);
            messages.scrollTop = messages.scrollHeight;
            if (!this._restoring) this._saveSession();
            return msg;
        }
    }

    _buildFeedbackRow(messageId) {
        const row = document.createElement('div');
        row.className = 'voltimax-chat-message__feedback';

        const upBtn = document.createElement('button');
        upBtn.className = 'voltimax-chat-message__feedback-btn';
        upBtn.title     = 'Hilfreich';
        upBtn.dataset.fb = 'up';
        upBtn.dataset.messageId = messageId || '';
        // Safe: hardcoded SVG (thumbs up)
        upBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14z"/><path d="M7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3"/></svg>';
        upBtn.addEventListener('click', (e) => this._onFeedback(e.currentTarget, 'up'));

        const downBtn = document.createElement('button');
        downBtn.className = 'voltimax-chat-message__feedback-btn';
        downBtn.title     = 'Nicht hilfreich';
        downBtn.dataset.fb = 'down';
        downBtn.dataset.messageId = messageId || '';
        // Safe: hardcoded SVG (thumbs down)
        downBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17"/></svg>';
        downBtn.addEventListener('click', (e) => this._onFeedback(e.currentTarget, 'down'));

        row.appendChild(upBtn);
        row.appendChild(downBtn);
        return row;
    }

    _onFeedback(btn, feedback) {
        const feedbackRow = btn.closest('.voltimax-chat-message__feedback');
        feedbackRow.querySelectorAll('.voltimax-chat-message__feedback-btn').forEach(b => {
            b.classList.toggle('is-active', b.dataset.fb === feedback);
            b.disabled = true;
        });
        if (this._sessionId && btn.dataset.messageId) {
            this._callServerB('/chat/feedback', {
                session_id: this._sessionId,
                message_id: btn.dataset.messageId,
                feedback,
            });
        }
    }

    _incrementBadge() {
        this._unreadCount++;
        const badge = this._bubbleEl?.querySelector('.voltimax-chat-bubble__badge');
        if (badge) {
            badge.textContent = this._unreadCount > 9 ? '9+' : String(this._unreadCount);
            badge.style.display = '';
        }
        // Show floating notification toast
        this._showUnreadToast();
    }

    _showUnreadToast() {
        // Remove existing toast
        const existing = document.querySelector('.voltimax-chat-toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'voltimax-chat-toast';
        const posClass = this.config?.widgetPosition === 'bottom-left' ? 'voltimax-chat-toast--bottom-left' : 'voltimax-chat-toast--bottom-right';
        toast.classList.add(posClass);

        const count = this._unreadCount;
        toast.textContent = count === 1 ? '1 neue Nachricht' : `${count} neue Nachrichten`;
        toast.addEventListener('click', () => {
            toast.remove();
            this._unminimize();
        });
        document.body.appendChild(toast);

        // Auto-dismiss after 4s
        setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4000);
    }

    // ── Sub-card chips in chat (kept for Server B responses) ──────────────────

    _renderSubCardChips(parentTopic) {
        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;

        const row = document.createElement('div');
        row.className = 'voltimax-chat-subcards-row';

        parentTopic.sub_cards.forEach(sub => {
            const chip = document.createElement('button');
            chip.className = 'voltimax-chat-subcard-chip';
            const iconSpan = document.createElement('span');
            iconSpan.textContent = sub.icon || '\uD83D\uDCAC';
            chip.appendChild(iconSpan);
            const label = document.createTextNode(' ' + sub.title);
            chip.appendChild(label);
            chip.addEventListener('click', () => {
                row.remove();
                // Select this sub-topic
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({
                        type: 'select_topic',
                        topic_id: sub.id,
                        chat_id: this._chatId,
                    }));
                }
                this.currentTopic = sub.id;
            });
            row.appendChild(chip);
        });

        messages.appendChild(row);
        messages.scrollTop = messages.scrollHeight;
    }

    // ── Streaming ─────────────────────────────────────────────────────────────

    _appendToken(token) {
        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return;

        // A docked orb stays visible while tokens stream; only a legacy
        // in-flow indicator (no input slot available) must make way for
        // the streaming bubble.
        if (this._typingEl && !this._typingEl.classList.contains('voltimax-chat-typing--dock')) {
            this._hideTypingIndicator();
        }

        let streamBubble = messages.querySelector('.voltimax-chat-message--ai.is-streaming');
        if (!streamBubble) {
            // Create the full row structure for the streaming bubble
            const row = document.createElement('div');
            row.className = 'voltimax-chat-ai-row';
            this._streamingRow = row;

            const avatarEl = this._buildAvatarEl();

            const rowBody = document.createElement('div');
            rowBody.className = 'voltimax-chat-ai-row__body';

            streamBubble = document.createElement('div');
            streamBubble.className = 'voltimax-chat-message voltimax-chat-message--ai is-streaming';

            rowBody.appendChild(streamBubble);
            row.appendChild(avatarEl);
            row.appendChild(rowBody);
            messages.appendChild(row);
            this._streamingRaw = '';
        }

        this._streamingRaw = (this._streamingRaw || '') + token;

        // Rebuild DOM from accumulated markdown text (XSS-safe: all text via textContent)
        while (streamBubble.firstChild) streamBubble.removeChild(streamBubble.firstChild);
        streamBubble.appendChild(this._buildMessageNodes(this._streamingRaw));
        messages.scrollTop = messages.scrollHeight;
    }

    // ── Typing indicator ──────────────────────────────────────────────────────

    _showTypingIndicator() {
        // Update last user message status to "Delivered"
        if (this._lastUserStatusEl) {
            // Delivered: second check appears (still navy); 'read' turns both green
            this._lastUserStatusEl.classList.add('is-delivered');
            const deliveredLabel = this._lastUserStatusEl.querySelector('.vtx-status-label');
            if (deliveredLabel) deliveredLabel.textContent = 'Zugestellt';
        }

        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages || document.querySelector('.voltimax-chat-widget .voltimax-chat-typing')) return;

        // Siri-style oracle orb — docks centered IN PLACE of the input bar;
        // _hideTypingIndicator() brings the input back when the answer starts.
        const typing = document.createElement('div');
        typing.className = 'voltimax-chat-typing voltimax-chat-typing--dock';

        const orb = document.createElement('div');
        orb.className = 'vtx-orb';
        orb.setAttribute('role', 'status');
        orb.setAttribute('aria-label', 'GrootDesk denkt nach …');

        // Three translucent light-petals crossing over a dark glassy sphere,
        // with a white flare where they intersect (screen blending).
        ['r', 'b', 'c'].forEach(function(tone) {
            const petal = document.createElement('span');
            petal.className = 'vtx-orb__petal vtx-orb__petal--' + tone;
            orb.appendChild(petal);
        });
        const flare = document.createElement('span');
        flare.className = 'vtx-orb__flare';
        orb.appendChild(flare);

        // Flight wrapper carries the travel transform so the orb's own
        // breathe animation (also transform-based) keeps running inside it.
        const flight = document.createElement('span');
        flight.className = 'vtx-orb-flight';
        flight.appendChild(orb);
        typing.appendChild(flight);

        // Measure the send-button orb BEFORE hiding the input, so the big
        // orb can fly out of it (morph: amber send orb -> thinking orb).
        const sendOrb = document.querySelector('.voltimax-chat-window__send .vtx-orb');
        const fromRect = sendOrb ? sendOrb.getBoundingClientRect() : null;

        const inputArea = document.querySelector('.voltimax-chat-window__input-area');
        if (inputArea && inputArea.parentElement) {
            inputArea.style.display = 'none';
            inputArea.parentElement.insertBefore(typing, inputArea);
        } else {
            messages.appendChild(typing);
        }
        messages.scrollTop = messages.scrollHeight;

        if (fromRect) {
            const toRect = flight.getBoundingClientRect();
            if (toRect.width > 0) {
                const dx = (fromRect.left + fromRect.width / 2) - (toRect.left + toRect.width / 2);
                const dy = (fromRect.top + fromRect.height / 2) - (toRect.top + toRect.height / 2);
                const scale = fromRect.width / toRect.width;
                flight.style.transition = 'none';
                flight.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + scale + ')';
                orb.classList.add('vtx-orb--arriving');
                requestAnimationFrame(function() {
                    requestAnimationFrame(function() {
                        flight.style.transition = 'transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)';
                        flight.style.transform = 'translate(0, 0) scale(1)';
                        orb.classList.remove('vtx-orb--arriving');
                        setTimeout(function() { flight.style.transition = ''; }, 550);
                    });
                });
            }
        }

        this._typingEl = typing;
    }

    _hideTypingIndicator() {
        if (this._typingEl) {
            this._typingEl.remove();
            this._typingEl = null;
        }
        const inputArea = document.querySelector('.voltimax-chat-window__input-area');
        if (inputArea) inputArea.style.display = '';
    }

    _showEscalation(data) {
        this._addMessage('ai', data.message || 'Would you like to speak with a team member?');
    }

    // A confirmation form is state, not decoration: once resolved it becomes an
    // inert receipt, so stale copies in the scrollback can never fire actions
    // again (a cancel on an old form once "cancelled" an already-created ticket).
    _finalizeConfirmCard(card, statusText, ok) {
        if (!card || (card.dataset.state !== 'live' && card.dataset.state !== 'submitting')) return;
        card.dataset.state = 'done';
        card.querySelectorAll('input, textarea, select, button').forEach(el => { el.disabled = true; });
        const actions = card.querySelector('.voltimax-chat-confirm__actions');
        if (actions) {
            const status = document.createElement('div');
            status.className = 'voltimax-chat-confirm__status' + (ok ? ' is-ok' : '');
            status.textContent = statusText;
            actions.replaceWith(status);
        }
    }

    _buildConfirmationDOM(confirmation) {
        // A new form supersedes any older still-open one — exactly one live
        // confirmation form per conversation.
        const self = this;
        document.querySelectorAll('.voltimax-chat-confirm[data-state="live"]').forEach(old => {
            self._finalizeConfirmCard(old, '↓ Ersetzt durch ein neues Formular', false);
        });

        const card = document.createElement('div');
        card.className = 'voltimax-chat-confirm';
        card.dataset.state = 'live';

        // Header with icon and title
        const header = document.createElement('div');
        header.className = 'voltimax-chat-confirm__header';
        // Safe: hardcoded SVG (shield check icon)
        header.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
        const titleEl = document.createElement('span');
        titleEl.textContent = confirmation.title || 'Bitte bestätigen';
        header.appendChild(titleEl);
        card.appendChild(header);

        // Summary text
        if (confirmation.summary) {
            const summary = document.createElement('div');
            summary.className = 'voltimax-chat-confirm__summary';
            summary.textContent = confirmation.summary;
            card.appendChild(summary);
        }

        // Fields
        const fieldsContainer = document.createElement('div');
        fieldsContainer.className = 'voltimax-chat-confirm__fields';
        const fieldInputs = {};

        (confirmation.fields || []).forEach(field => {
            const row = document.createElement('div');
            row.className = 'voltimax-chat-confirm__field';

            const label = document.createElement('label');
            label.className = 'voltimax-chat-confirm__label';
            label.textContent = field.label;
            row.appendChild(label);

            if (field.editable) {
                let input;
                if (field.type === 'textarea') {
                    input = document.createElement('textarea');
                    input.className = 'voltimax-chat-confirm__input voltimax-chat-confirm__textarea';
                    input.rows = 3;
                    input.placeholder = field.label + ' *';
                } else {
                    input = document.createElement('input');
                    input.className = 'voltimax-chat-confirm__input';
                    input.type = field.type || (field.key === 'customer_email' ? 'email' : 'text');
                    // Concrete example placeholder — 'Bestell-E-Mail *' alone was
                    // misread as an order-number field (prod chat #93BBFF71)
                    input.placeholder = field.key === 'customer_email' ? 'name@beispiel.de' : field.label + ' *';
                }
                input.value = field.value || '';
                input.required = true;
                input.dataset.key = field.key;
                // Clear error on input
                input.addEventListener('input', () => { input.style.borderColor = ''; });

                // Prefix support: fixed text + editable input in one row
                if (field.prefix) {
                    const prefixRow = document.createElement('div');
                    prefixRow.style.cssText = 'display:flex;align-items:center;gap:0;';
                    const prefixEl = document.createElement('span');
                    prefixEl.style.cssText = 'font-size:12px;font-weight:600;color:#78716c;white-space:nowrap;padding:6px 4px 6px 10px;background:#f8f9fc;border:1px solid #e2e8f0;border-right:none;border-radius:8px 0 0 8px;';
                    prefixEl.textContent = field.prefix;
                    input.style.borderRadius = '0 8px 8px 0';
                    prefixRow.appendChild(prefixEl);
                    prefixRow.appendChild(input);
                    row.appendChild(prefixRow);
                } else {
                    row.appendChild(input);
                }
                fieldInputs[field.key] = input;
            } else {
                const value = document.createElement('div');
                value.className = 'voltimax-chat-confirm__value';
                value.textContent = field.value || '\u2014';
                row.appendChild(value);
                fieldInputs[field.key] = { value: field.value || '' };
            }

            fieldsContainer.appendChild(row);
        });
        card.appendChild(fieldsContainer);

        // Action buttons
        const actions = document.createElement('div');
        actions.className = 'voltimax-chat-confirm__actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'voltimax-chat-confirm__btn voltimax-chat-confirm__btn--cancel';
        cancelBtn.textContent = 'Abbrechen';
        cancelBtn.addEventListener('click', () => {
            // Collapse to a receipt instead of removing — the transcript stays
            // readable and the form can never be interacted with again.
            this._finalizeConfirmCard(card, 'Formular geschlossen', false);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'cancel_action', action: confirmation.action }));
            }
        });
        // Inline feedback right at the buttons (validation / connection issues)
        const confirmNotice = document.createElement('div');
        confirmNotice.setAttribute('role', 'alert');
        confirmNotice.style.cssText = 'display:none;margin-top:8px;padding:8px 10px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:12px;font-weight:600;color:#b91c1c;text-align:center';


        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'voltimax-chat-confirm__btn voltimax-chat-confirm__btn--confirm';
        confirmBtn.textContent = 'Bestätigen \u2192';
        confirmBtn.addEventListener('click', () => {
            // Collect field values
            const fields = {};
            let hasEmpty = false;
            let emailInvalid = false;
            for (const [key, el] of Object.entries(fieldInputs)) {
                if (el instanceof HTMLElement) {
                    fields[key] = el.value;
                    // Validate required editable fields
                    if (!el.value.trim()) {
                        el.style.borderColor = '#ef4444';
                        hasEmpty = true;
                    } else if (key === 'customer_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim())) {
                        // Order numbers typed into the e-mail field sailed
                        // through to Zendesk and died as an unexplained 422
                        // (prod chat #93BBFF71)
                        el.style.borderColor = '#ef4444';
                        emailInvalid = true;
                    } else {
                        el.style.borderColor = '';
                    }
                } else {
                    fields[key] = el.value;
                }
            }

            if (hasEmpty || emailInvalid) {
                confirmNotice.textContent = emailInvalid
                    ? 'Bitte gib eine g\u00fcltige E-Mail-Adresse ein (z.B. name@beispiel.de).'
                    : 'Bitte f\u00fclle alle Felder aus \u2014 siehe rote Markierung.';
                confirmNotice.style.display = 'block';
                return;
            }
            confirmNotice.style.display = 'none';

            // A dead connection would silently swallow the submission while
            // the form showed an eternal "Wird gesendet \u2026" spinner
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                confirmNotice.textContent = 'Verbindung unterbrochen \u2014 bitte lade die Seite neu und sende das Formular danach erneut.';
                confirmNotice.style.display = 'block';
                return;
            }

            // Disable buttons, show loading
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;
            confirmBtn.textContent = 'Wird gesendet \u2026';
            card.dataset.state = 'submitting';

            this.ws.send(JSON.stringify({
                type: 'confirm_action',
                action: confirmation.action,
                fields: fields,
            }));

            if (confirmation.action === 'create_ticket') {
                // Ack-driven: 'confirmation_done' carries the real ticket number;
                // 'error' re-enables the form instead of faking success.
                this._pendingConfirmCard = card;
                // No ack within 20s → reopen honestly instead of spinning forever
                if (this._confirmAckTimer) clearTimeout(this._confirmAckTimer);
                this._confirmAckTimer = setTimeout(() => {
                    if (this._pendingConfirmCard === card && card.dataset.state === 'submitting') {
                        this._pendingConfirmCard = null;
                        card.dataset.state = 'live';
                        card.querySelectorAll('input, textarea, select, button').forEach(function(el) { el.disabled = false; });
                        confirmBtn.textContent = 'Best\u00e4tigen \u2192';
                        confirmNotice.textContent = 'Keine Best\u00e4tigung vom Server erhalten \u2014 bitte sende das Formular erneut.';
                        confirmNotice.style.display = 'block';
                    }
                }, 20000);
            } else {
                // Other actions have no ack channel \u2014 optimistic receipt
                setTimeout(() => {
                    this._finalizeConfirmCard(card, '\u2713 Anfrage \u00fcbermittelt', true);
                }, 500);
            }
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        card.appendChild(actions);
        card.appendChild(confirmNotice);

        return card;
    }

    _showConfirmationCard(confirmation) {
        let messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) {
            this._buildChatUI(this.currentTopic || 'general');
            messages = document.querySelector('.voltimax-chat-window__messages');
        }
        if (!messages) return;
        this._hideTypingIndicator();
        var card = this._buildConfirmationDOM(confirmation);
        if (card) {
            messages.appendChild(card);
            messages.scrollTop = messages.scrollHeight;
        }
    }

    // ── Interactive UI elements ────────────────────────────────────────────────

    _renderChoices(message, choices) {
        let messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) {
            this._buildChatUI(this.currentTopic || 'general');
            messages = document.querySelector('.voltimax-chat-window__messages');
        }
        if (!messages) return;

        // Remove typing indicator
        this._hideTypingIndicator();

        // Show message text as AI message if provided
        if (message) {
            this._addMessage('ai', message);
        }

        // Render choice buttons
        const row = document.createElement('div');
        row.className = 'vtx-choices';

        choices.forEach(choice => {
            const btn = document.createElement('button');
            btn.className = 'vtx-choice-btn';
            btn.textContent = choice;
            btn.addEventListener('click', () => {
                // Show as user message
                this._addMessage('user', choice);
                row.remove();
                // Send as regular message
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'message', content: choice }));
                    this._showTypingIndicator();
                }
            });
            row.appendChild(btn);
        });

        messages.appendChild(row);
        messages.scrollTop = messages.scrollHeight;
    }

    _renderInputPrompt(prompt) {
        let messages = document.querySelector('.voltimax-chat-window__messages');

        // If not in chat mode yet, switch to chat first
        if (!messages) {
            const topicId = this.currentTopic || 'order_status';
            this._buildChatUI(topicId);
            messages = document.querySelector('.voltimax-chat-window__messages');
        }
        if (!messages) return;

        this._hideTypingIndicator();

        const card = document.createElement('div');
        card.className = 'vtx-input-prompt';

        const label = document.createElement('div');
        label.className = 'vtx-input-prompt__label';
        label.textContent = prompt.label || 'Enter value';
        card.appendChild(label);

        // Support multi-field prompts (e.g. order number + email)
        const fieldInputs = {};
        const promptFields = prompt.fields || [{ name: prompt.field, label: '', placeholder: prompt.placeholder || '', type: 'text' }];

        promptFields.forEach(field => {
            const fieldRow = document.createElement('div');
            fieldRow.className = 'vtx-input-prompt__field-row';

            if (field.label && promptFields.length > 1) {
                const fieldLabel = document.createElement('label');
                fieldLabel.className = 'vtx-input-prompt__field-label';
                fieldLabel.textContent = field.label;
                fieldRow.appendChild(fieldLabel);
            }

            const input = document.createElement('input');
            input.className = 'vtx-input-prompt__input';
            input.type = field.type || 'text';
            input.placeholder = field.placeholder || '';
            if (field.value) input.value = field.value;
            input.dataset.name = field.name;
            fieldRow.appendChild(input);

            card.appendChild(fieldRow);
            fieldInputs[field.name] = input;
        });

        const btnRow = document.createElement('div');
        btnRow.className = 'vtx-input-prompt__row';

        const submitBtn = document.createElement('button');
        submitBtn.className = 'vtx-input-prompt__submit';
        submitBtn.textContent = 'Verify \u2192';
        submitBtn.style.width = '100%';
        btnRow.appendChild(submitBtn);
        card.appendChild(btnRow);

        const errorEl = document.createElement('div');
        errorEl.className = 'vtx-input-prompt__error';
        card.appendChild(errorEl);

        const doSubmit = () => {
            // Validate all fields have values
            const values = {};
            let firstEmpty = null;
            for (const [name, input] of Object.entries(fieldInputs)) {
                const val = input.value.trim();
                if (!val) {
                    firstEmpty = input;
                    break;
                }
                values[name] = val;
            }
            if (firstEmpty) {
                errorEl.textContent = 'Please fill in all fields';
                firstEmpty.focus();
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Wird gepr\u00fcft \u2026';
            Object.values(fieldInputs).forEach(inp => { inp.disabled = true; });

            // Determine the primary value (first field) and send all as fields
            const primaryValue = Object.values(values)[0] || '';

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'input_response',
                    input_field: prompt.field || promptFields[0].name,
                    input_value: primaryValue.replace(/^#/, ''),
                    fields: values,
                }));
            }

            // Re-enable after timeout if no response
            setTimeout(() => {
                if (card.parentNode) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Verify \u2192';
                    Object.values(fieldInputs).forEach(inp => { inp.disabled = false; });
                }
            }, 8000);
        };

        submitBtn.addEventListener('click', doSubmit);
        // Allow Enter in any field to submit
        Object.values(fieldInputs).forEach(input => {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doSubmit(); }
            });
        });

        messages.appendChild(card);
        messages.scrollTop = messages.scrollHeight;
        // Focus the first empty field
        const firstInput = Object.values(fieldInputs)[0];
        if (firstInput) firstInput.focus();
    }

    _buildInfoCardElement(card) {
        if (!card) return null;
        return this._buildInfoCardDOM(card);
    }

    _renderInfoCard(card) {
        let messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) {
            this._buildChatUI(this.currentTopic || 'general');
            messages = document.querySelector('.voltimax-chat-window__messages');
        }
        if (!messages) return;

        this._hideTypingIndicator();
        messages.querySelectorAll('.vtx-input-prompt').forEach(function(el) { el.remove(); });

        if (!this._restoring && card) {
            this._history.push({ kind: 'card', card: card });
            if (this._history.length > 60) this._history.shift();
        }

        var el = this._buildInfoCardDOM(card);
        if (el) {
            messages.appendChild(el);

            // For close_chat cards: hide suggestions and scroll fully into view
            if (card.card_type === 'close_chat') {
                var suggestionsWrap = document.querySelector('.vtx-suggestions-wrap');
                if (suggestionsWrap) suggestionsWrap.style.display = 'none';
                var suggestionsLegacy = document.querySelector('.vtx-suggestions');
                if (suggestionsLegacy) suggestionsLegacy.style.display = 'none';
            }

            // Delay scroll slightly so DOM has time to layout
            setTimeout(function() {
                messages.scrollTop = messages.scrollHeight;
                el.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }, 100);
        }
    }

    _buildInfoCardDOM(card) {
        if (!card) return null;

        // Style themes
        var themes = {
            green:  { bg: '#f0fdf4', border: '#22c55e', headerColor: '#15803d' },
            // "blue" is the default/info style — warm GrootDesk neutral, not blue.
            // border must stay a hex: card code derives an alpha tint via border + '30'.
            blue:   { bg: '#fdfaf6', border: '#b0703a', headerColor: '#8f5a2e' },
            amber:  { bg: '#fffbeb', border: '#f59e0b', headerColor: '#b45309' },
            red:    { bg: '#fef2f2', border: '#ef4444', headerColor: '#dc2626' },
            gray:   { bg: '#f8f9fa', border: '#78716c', headerColor: '#57534e' },
            purple: { bg: '#f5f3ff', border: '#8b5cf6', headerColor: '#6d28d9' },
        };

        // Normalize: convert legacy card types to dynamic format
        var c = card;
        if (card.card_type !== 'dynamic' && card.card_type !== 'close_chat' && card.card_type !== 'batteriepfand_upload') {
            c = Object.assign({}, card, card.data || {});
            if (!c.style) c.style = 'blue';
            if (!c.title && c.order_number) c.title = 'Bestellung #' + c.order_number;
        }

        // Special: close chat card
        if (c.card_type === 'close_chat') {
            var closeEl = document.createElement('div');
            // flex-shrink:0 is critical: the messages container is a flex column,
            // and without it this card gets compressed to a sliver once the chat
            // is taller than the window (observed in prod as 'a line').
            closeEl.style.cssText = 'flex-shrink:0;border-radius:14px;overflow:hidden;border:1px solid #e7e5e0;background:#fff;margin-bottom:6px';

            var closeHeader = document.createElement('div');
            closeHeader.style.cssText = 'padding:14px 16px;text-align:center;border-bottom:1px solid #f4f2ef';
            var closeIcon = document.createElement('div');
            closeIcon.style.cssText = 'font-size:24px;margin-bottom:6px';
            closeIcon.textContent = '\uD83D\uDC4B';
            closeHeader.appendChild(closeIcon);
            var closeTitle = document.createElement('div');
            closeTitle.style.cssText = 'font-size:14px;font-weight:600;color:#57534e;margin-bottom:4px';
            closeTitle.textContent = c.title || 'Kann ich noch etwas f\u00fcr dich tun?';
            closeHeader.appendChild(closeTitle);
            if (c.description) {
                var closeDesc = document.createElement('div');
                closeDesc.style.cssText = 'font-size:12px;color:#78716c';
                closeDesc.textContent = c.description;
                closeHeader.appendChild(closeDesc);
            }
            closeEl.appendChild(closeHeader);

            var closeBtns = document.createElement('div');
            closeBtns.style.cssText = 'display:flex;gap:8px;padding:12px 16px';

            var self = this;

            var closeBtn = document.createElement('button');
            closeBtn.style.cssText = 'flex:1;padding:10px;border:1px solid #ef4444;background:#fff;color:#ef4444;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
            closeBtn.textContent = 'Chat schlie\u00dfen';
            closeBtn.addEventListener('mouseenter', function() { closeBtn.style.background = '#fef2f2'; });
            closeBtn.addEventListener('mouseleave', function() { closeBtn.style.background = '#fff'; });
            closeBtn.addEventListener('click', function() {
                closeEl.remove();
                self._close();
            });
            closeBtns.appendChild(closeBtn);

            var newBtn = document.createElement('button');
            newBtn.style.cssText = 'flex:1;padding:10px;border:none;background:#2b2013;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
            newBtn.textContent = 'Neuen Chat starten';
            newBtn.addEventListener('mouseenter', function() { newBtn.style.background = '#1c140b'; });
            newBtn.addEventListener('mouseleave', function() { newBtn.style.background = '#2b2013'; });
            newBtn.addEventListener('click', function() {
                closeEl.remove();
                self._resetChat();
            });
            closeBtns.appendChild(newBtn);

            closeEl.appendChild(closeBtns);
            return closeEl;
        }

        var theme = themes[c.style] || themes.blue;

        // Card stays a calm white surface with ONE hairline border (SCSS);
        // state is expressed by the header badge and value pills, not by
        // tinting the whole card.
        var el = document.createElement('div');
        el.className = 'vtx-info-card';

        // Soft badge palette (light tint + readable ink)
        var badgeStyles = {
            success: 'color:#15803d;background:#e9f6ee',
            warning: 'color:#b45309;background:#fdf4e3',
            danger:  'color:#b91c1c;background:#fdecec',
            muted:   'color:#78716c;background:#f4f2ef',
        };
        var badgeBase = 'flex-shrink:0;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.6;';

        // Tone for a status value: trust an explicit row style, otherwise
        // derive it from the (real customer) value so live data gets the
        // same badge treatment as any demo.
        var statusTone = function(value, style) {
            if (badgeStyles[style]) return style;
            var v = String(value || '').toLowerCase();
            if (/(abgeschlossen|versandt|versendet|geliefert|bezahlt|erstattet|aktiv|bestätigt|completed|shipped|delivered|paid|done|refunded)/.test(v)) return 'success';
            if (/(offen|in bearbeitung|bearbeitung|ausstehend|wartet|teilweise|angekündigt|open|pending|processing|partial)/.test(v)) return 'warning';
            if (/(storniert|abgebrochen|fehlgeschlagen|abgelehnt|cancelled|canceled|failed|rejected)/.test(v)) return 'danger';
            return 'muted';
        };

        // Promote an explicit status row into a header badge (demo style)
        var badgeRow = null;
        var badgeTone = null;
        if (c.rows && c.rows.length > 0) {
            badgeRow = c.rows.find(function(r) {
                return r && r.value && /^status$/i.test(String(r.label || '').trim());
            }) || null;
            if (badgeRow) badgeTone = statusTone(badgeRow.value, badgeRow.style);
        }

        // "Bestellung #123 — Verifiziert" → clean title + a Verifiziert badge
        // (only when no status badge occupies the slot).
        var title = c.title || '';
        var verifiedMatch = /^(.*?)\s*[—–-]\s*verifiziert\s*$/i.exec(title);
        if (verifiedMatch) title = verifiedMatch[1];

        // Header: title left, badge right
        if (title || badgeRow || verifiedMatch) {
            var header = document.createElement('div');
            header.className = 'vtx-info-card__header';
            var titleSpan = document.createElement('span');
            titleSpan.textContent = (c.icon ? c.icon + ' ' : '') + title;
            header.appendChild(titleSpan);
            if (badgeRow || verifiedMatch) {
                var badge = document.createElement('span');
                badge.className = 'vtx-info-card__badge';
                if (badgeRow) {
                    badge.textContent = badgeRow.value;
                    badge.style.cssText = badgeBase + badgeStyles[badgeTone];
                } else {
                    badge.textContent = 'Verifiziert ✓';
                    badge.style.cssText = badgeBase + badgeStyles.success;
                }
                header.appendChild(badge);
            }
            el.appendChild(header);
        }

        // Rows grid (status row lives in the header badge now)
        if (c.rows && c.rows.length > 0) {
            var grid = document.createElement('div');
            grid.className = 'vtx-info-card__grid';
            c.rows.forEach(function(row) {
                if (row === badgeRow) return;
                var label = document.createElement('span');
                label.className = 'vtx-info-card__label';
                label.textContent = row.label;
                grid.appendChild(label);

                var value = document.createElement('span');
                value.className = 'vtx-info-card__value';
                value.textContent = row.value || '\u2014';
                var valueStyles = {
                    success: 'color:#15803d;font-weight:600',
                    warning: 'color:#b45309;font-weight:600',
                    danger: 'color:#b91c1c;font-weight:600',
                    muted: 'color:#a8a29e',
                };
                if (row.style && valueStyles[row.style]) {
                    value.style.cssText = valueStyles[row.style];
                }
                grid.appendChild(value);
            });
            el.appendChild(grid);
        }

        // Links (tracking, downloads, products)
        if (c.links && c.links.length > 0) {
            var linksDiv = document.createElement('div');
            linksDiv.style.cssText = 'padding:8px 12px;border-top:1px solid ' + theme.border + '30';
            var self = this;
            var linkIndex = 0;
            c.links.forEach(function(link) {
                if (link.detail) {
                    // Product link with detail — render as a mini product card
                    var isAlt = link.style === 'alternative';
                    var card = document.createElement('a');
                    card.href = self._safeUrl(link.url);
                    card.target = '_blank';
                    card.rel = 'noopener';
                    // GA4: track product click
                    (function(lnk, idx) {
                        card.addEventListener('click', function() {
                            self._trackProductClick(lnk, idx);
                        });
                    })(link, linkIndex++);

                    if (isAlt) {
                        card.style.cssText = 'display:block;text-decoration:none;padding:8px 12px;margin:-2px 0 6px 16px;border:1px solid #22c55e;border-radius:10px;background:' + theme.bg + ';transition:all 0.2s';
                        card.addEventListener('mouseenter', function() { card.style.borderColor = '#16a34a'; card.style.boxShadow = '0 2px 8px rgba(34,197,94,0.15)'; });
                        card.addEventListener('mouseleave', function() { card.style.borderColor = '#22c55e'; card.style.boxShadow = 'none'; });
                    } else {
                        card.style.cssText = 'display:block;text-decoration:none;padding:10px 12px;margin-bottom:6px;border:1px solid ' + theme.border + '30;border-radius:14px;background:' + theme.bg + ';transition:all 0.2s';
                        card.addEventListener('mouseenter', function() { card.style.borderColor = 'var(--vtx-primary, #b0703a)'; card.style.boxShadow = '0 2px 8px rgba(28,25,23,0.10)'; });
                        card.addEventListener('mouseleave', function() { card.style.borderColor = theme.border + '30'; card.style.boxShadow = 'none'; });
                    }

                    // Layout: [thumbnail?] [name + detail] [chevron]
                    var inner = document.createElement('div');
                    inner.style.cssText = 'display:flex;align-items:center;gap:10px';

                    var imgUrl = link.image ? self._safeUrl(link.image) : '#';
                    if (!isAlt && imgUrl !== '#') {
                        var thumb = document.createElement('img');
                        thumb.src = imgUrl;
                        thumb.alt = '';
                        thumb.loading = 'lazy';
                        thumb.style.cssText = 'width:44px;height:44px;object-fit:contain;border-radius:8px;background:#fff;border:1px solid rgba(0,0,0,0.06);flex-shrink:0';
                        thumb.addEventListener('error', function() { thumb.remove(); });
                        inner.appendChild(thumb);
                    }

                    var textCol = document.createElement('div');
                    textCol.style.cssText = 'flex:1;min-width:0';

                    var nameEl = document.createElement('div');
                    nameEl.style.cssText = 'font-size:' + (isAlt ? '12px' : '13px') + ';font-weight:600;color:var(--vtx-primary, #8f5a2e);margin-bottom:4px;line-height:1.3';
                    nameEl.textContent = link.label;
                    textCol.appendChild(nameEl);

                    var lines = link.detail.split('\n');
                    lines.forEach(function(line) {
                        var lineEl = document.createElement('div');
                        lineEl.style.cssText = 'font-size:11px;color:#78716c;line-height:1.4';
                        lineEl.textContent = line;
                        textCol.appendChild(lineEl);
                    });
                    inner.appendChild(textCol);

                    if (!isAlt) {
                        var chevron = document.createElement('div');
                        chevron.style.cssText = 'flex-shrink:0;color:#a8a29e;display:flex;align-items:center';
                        // Safe: hardcoded SVG
                        chevron.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>';
                        inner.appendChild(chevron);
                    }

                    card.appendChild(inner);
                    linksDiv.appendChild(card);
                } else {
                    // Standard link (tracking, ticket copy, etc.)
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';

                    var a = document.createElement('a');
                    a.href = self._safeUrl(link.url);
                    a.target = '_blank';
                    a.rel = 'noopener';
                    a.className = 'vtx-choice-btn';
                    a.style.cssText = 'text-decoration:none;display:inline-flex;align-items:center;gap:4px';
                    a.textContent = link.label;
                    row.appendChild(a);

                    if (link.copy) {
                        var copyBtn = document.createElement('button');
                        copyBtn.className = 'vtx-choice-btn vtx-choice-btn--secondary';
                        copyBtn.style.cssText = 'padding:5px 8px;font-size:11px';
                        copyBtn.textContent = '\uD83D\uDCCB Kopieren';
                        var copyText = link.copy;
                        copyBtn.addEventListener('click', function() {
                            navigator.clipboard.writeText(copyText).then(function() {
                                copyBtn.textContent = '\u2713 Kopiert';
                                setTimeout(function() { copyBtn.textContent = '\uD83D\uDCCB Kopieren'; }, 1500);
                            });
                        });
                        row.appendChild(copyBtn);
                    }
                    linksDiv.appendChild(row);
                }
            });
            el.appendChild(linksDiv);
            // GA4: track product impressions for cards with product links
            this._trackProductImpression(c.links);
        }

        // Inline form (e.g. order lookup, compatibility check)
        if (c.form) {
            var formDiv = document.createElement('div');
            formDiv.style.cssText = 'padding:12px 16px;border-top:1px solid #f4f2ef';
            var formInputs = {};
            var cascadeUrl = c.form.cascade_url || null;
            var self = this;

            (c.form.fields || []).forEach(function(field) {
                var fieldRow = document.createElement('div');
                fieldRow.style.cssText = 'margin-bottom:8px';

                var label = document.createElement('label');
                label.style.cssText = 'display:block;font-size:11px;font-weight:600;color:#78716c;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.03em';
                label.textContent = field.label;
                fieldRow.appendChild(label);

                var inputEl;
                if (field.type === 'select') {
                    // Dropdown select
                    inputEl = document.createElement('select');
                    inputEl.style.cssText = 'width:100%;padding:9px 16px;border:1px solid #e7e5e0;border-radius:999px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;background:#fff;appearance:auto;transition:border-color 0.2s';
                    inputEl.dataset.name = field.name;

                    var placeholder = document.createElement('option');
                    placeholder.value = '';
                    placeholder.textContent = field.placeholder || 'W\u00e4hlen...';
                    placeholder.disabled = true;
                    placeholder.selected = true;
                    inputEl.appendChild(placeholder);

                    // Add initial options if provided
                    (field.options || []).forEach(function(opt) {
                        var o = document.createElement('option');
                        o.value = opt.id || opt.value || '';
                        o.textContent = opt.name || opt.label || '';
                        inputEl.appendChild(o);
                    });

                    // Disable if depends on another field
                    if (field.depends_on) {
                        inputEl.disabled = true;
                    }

                    // Cascade: on change, fetch children for next level
                    if (cascadeUrl) {
                        inputEl.addEventListener('change', function() {
                            var selectedId = this.value;
                            var fieldName = this.dataset.name;

                            // Find dependent fields and reset them
                            var fields = c.form.fields || [];
                            var foundSelf = false;
                            var selectedNames = {};
                            for (var fi = 0; fi < fields.length; fi++) {
                                if (fields[fi].name === fieldName) { foundSelf = true; continue; }
                                if (foundSelf && formInputs[fields[fi].name]) {
                                    var dep = formInputs[fields[fi].name];
                                    dep.innerHTML = '';
                                    var ph = document.createElement('option');
                                    ph.value = '';
                                    ph.textContent = 'Laden...';
                                    ph.disabled = true;
                                    ph.selected = true;
                                    dep.appendChild(ph);
                                    dep.disabled = true;
                                }
                                // Collect selected values for vehicle name
                                if (!foundSelf && formInputs[fields[fi].name]) {
                                    var sv = formInputs[fields[fi].name];
                                    if (sv.selectedOptions && sv.selectedOptions[0]) {
                                        selectedNames[fields[fi].name] = sv.selectedOptions[0].textContent;
                                    }
                                }
                            }

                            // Fetch children for the next dependent field
                            var nextField = null;
                            for (var nf = 0; nf < fields.length; nf++) {
                                if (fields[nf].depends_on === fieldName) {
                                    nextField = fields[nf].name;
                                    break;
                                }
                            }
                            if (nextField && formInputs[nextField] && selectedId) {
                                var baseUrl = (self.config && self.config.serverBUrl) ? self.config.serverBUrl : '';
                                fetch(baseUrl + cascadeUrl + '?parent_id=' + encodeURIComponent(selectedId))
                                    .then(function(r) { return r.json(); })
                                    .then(function(data) {
                                        var nextSelect = formInputs[nextField];
                                        nextSelect.innerHTML = '';
                                        var ph2 = document.createElement('option');
                                        ph2.value = '';
                                        var nextFieldDef = fields.find(function(f) { return f.name === nextField; });
                                        ph2.textContent = (nextFieldDef && nextFieldDef.placeholder) || 'W\u00e4hlen...';
                                        ph2.disabled = true;
                                        ph2.selected = true;
                                        nextSelect.appendChild(ph2);
                                        (data.children || []).forEach(function(child) {
                                            var opt = document.createElement('option');
                                            opt.value = child.id || '';
                                            opt.textContent = child.name || '';
                                            nextSelect.appendChild(opt);
                                        });
                                        nextSelect.disabled = false;
                                    })
                                    .catch(function() {
                                        var nextSelect = formInputs[nextField];
                                        nextSelect.innerHTML = '<option disabled selected>Fehler beim Laden</option>';
                                    });
                            }
                        });
                    }
                } else {
                    // Text/email input
                    inputEl = document.createElement('input');
                    inputEl.type = field.type || 'text';
                    inputEl.placeholder = field.placeholder || '';
                    inputEl.style.cssText = 'width:100%;padding:9px 16px;border:1px solid #e7e5e0;border-radius:999px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;transition:border-color 0.2s, box-shadow 0.2s';
                    inputEl.addEventListener('focus', function() { this.style.borderColor = 'color-mix(in srgb, var(--vtx-primary, #d99a4e) 45%, #fff)'; this.style.boxShadow = '0 0 0 3px color-mix(in srgb, var(--vtx-primary, #d99a4e) 12%, transparent)'; });
                    inputEl.addEventListener('blur', function() { this.style.borderColor = '#e7e5e0'; this.style.boxShadow = 'none'; });
                    inputEl.dataset.name = field.name;
                }

                fieldRow.appendChild(inputEl);
                formInputs[field.name] = inputEl;
                formDiv.appendChild(fieldRow);
            });

            var submitBtn = document.createElement('button');
            submitBtn.style.cssText = 'display:block;margin-left:auto;width:auto;padding:8px 18px;background:#2b2013;color:#fff;border:none;border-radius:999px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:background 0.15s';
            submitBtn.addEventListener('mouseenter', function() { submitBtn.style.background = '#1c140b'; });
            submitBtn.addEventListener('mouseleave', function() { submitBtn.style.background = '#2b2013'; });
            submitBtn.textContent = c.form.submit_label || 'Submit';

            var doFormSubmit = function() {
                var values = {};
                var firstEmpty = null;
                var vehicleNameParts = [];
                for (var name in formInputs) {
                    var el = formInputs[name];
                    var val = el.value ? el.value.trim() : '';
                    if (!val) { firstEmpty = el; break; }
                    values[name] = val;
                    // Collect display names for vehicle
                    if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) {
                        vehicleNameParts.push(el.selectedOptions[0].textContent);
                    }
                }
                if (firstEmpty) { firstEmpty.focus(); firstEmpty.style.borderColor = '#ef4444'; setTimeout(function() { firstEmpty.style.borderColor = ''; }, 2000); return; }

                values.vehicle_name = vehicleNameParts.join(' \u2014 ');
                submitBtn.disabled = true;
                submitBtn.textContent = 'Suche...';

                var primaryValue = Object.values(values)[0] || '';
                // For compatibility, send the last selected value as primary (deepest level)
                var allValues = Object.values(values);
                var lastValue = allValues[allValues.length - 2] || primaryValue; // -2 because vehicle_name is last

                if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                    self.ws.send(JSON.stringify({
                        type: 'input_response',
                        input_field: c.form.field || c.form.fields[0].name,
                        input_value: lastValue.replace(/^#/, ''),
                        fields: values,
                    }));
                    // Verification lookups get a progress card that flips
                    // green when the verified card arrives.
                    var lookupField = String(c.form.field || (c.form.fields[0] && c.form.fields[0].name) || '');
                    if (/verify|order|ticket/i.test(lookupField)) {
                        self._showVerifyingCard(/ticket/i.test(lookupField)
                            ? 'Ticket wird gepr\u00fcft \u2026'
                            : 'Bestellung wird \u00fcberpr\u00fcft \u2026');
                    }
                }
                setTimeout(function() { submitBtn.disabled = false; submitBtn.textContent = c.form.submit_label || 'Submit'; }, 8000);
            };

            submitBtn.addEventListener('click', doFormSubmit);
            Object.values(formInputs).forEach(function(inp) {
                if (inp.tagName !== 'SELECT') {
                    inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') { e.preventDefault(); doFormSubmit(); } });
                }
            });

            formDiv.appendChild(submitBtn);
            el.appendChild(formDiv);
        }

        // Description
        if (c.description) {
            var desc = document.createElement('div');
            desc.style.cssText = 'padding:10px 16px;font-size:12px;color:#78716c;border-top:1px solid #f4f2ef;white-space:pre-line';
            desc.textContent = c.description;
            el.appendChild(desc);
        }

        // Steps (full-width paragraphs — used by Batteriepfand)
        if (c.steps && c.steps.length > 0) {
            var stepsDiv = document.createElement('div');
            stepsDiv.style.cssText = 'padding:12px 16px;border-top:1px solid #f4f2ef';

            c.steps.forEach(function(step) {
                var stepEl = document.createElement('div');
                var isWarning = step.style === 'warning';
                stepEl.style.cssText = 'margin-bottom:12px;padding:10px 12px;border-radius:8px;background:' + (isWarning ? '#fefce8' : '#faf9f7') + ';border-left:3px solid ' + (isWarning ? '#f59e0b' : '#22c55e');

                var titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-size:12px;font-weight:700;color:' + (isWarning ? '#92400e' : '#57534e') + ';margin-bottom:4px';
                titleEl.textContent = step.title;
                stepEl.appendChild(titleEl);

                var textEl = document.createElement('div');
                textEl.style.cssText = 'font-size:12px;color:#78716c;line-height:1.5';
                textEl.textContent = step.text;
                stepEl.appendChild(textEl);

                stepsDiv.appendChild(stepEl);
            });

            el.appendChild(stepsDiv);
        }

        // Batteriepfand upload form — select type + single file upload
        var self = this;
        if (c.card_type === 'batteriepfand_upload' && c.upload_options) {
            var uploadDiv = document.createElement('div');
            uploadDiv.style.cssText = 'padding:12px 16px;border-top:1px solid #f4f2ef';

            // Radio selector for form type
            var selectedType = { value: '' };
            var radioGroup = document.createElement('div');
            radioGroup.style.cssText = 'margin-bottom:12px';

            c.upload_options.forEach(function(opt) {
                var radioRow = document.createElement('label');
                radioRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:4px;border:1px solid #e0ddd7;border-radius:8px;cursor:pointer;transition:all 0.2s;font-size:13px;color:#57534e';
                radioRow.addEventListener('mouseenter', function() { radioRow.style.borderColor = '#22c55e'; });
                radioRow.addEventListener('mouseleave', function() { if (selectedType.value !== opt.key) radioRow.style.borderColor = '#e0ddd7'; });

                var radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'batteriepfand_type';
                radio.value = opt.key;
                radio.style.cssText = 'accent-color:#22c55e';
                radio.addEventListener('change', function() {
                    selectedType.value = opt.key;
                    radioGroup.querySelectorAll('label').forEach(function(l) { l.style.borderColor = '#e0ddd7'; l.style.background = '#fff'; });
                    radioRow.style.borderColor = '#22c55e';
                    radioRow.style.background = '#f0fdf4';
                });
                radioRow.appendChild(radio);

                var labelText = document.createElement('span');
                labelText.textContent = opt.label;
                radioRow.appendChild(labelText);

                radioGroup.appendChild(radioRow);
            });
            uploadDiv.appendChild(radioGroup);

            // Single file upload
            var fileRow = document.createElement('div');
            fileRow.style.cssText = 'margin-bottom:10px';
            var fileLabel = document.createElement('label');
            fileLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#57534e;margin-bottom:4px';
            fileLabel.textContent = 'PDF hochladen oder hierher ziehen *';
            fileRow.appendChild(fileLabel);
            var fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.pdf';
            fileInput.style.cssText = 'display:block;width:100%;font-size:12px;padding:6px;border:1px solid #e0ddd7;border-radius:6px;background:#faf9f7';
            fileRow.appendChild(fileInput);
            // Drag & drop support
            fileRow.addEventListener('dragover', function(e) {
                e.preventDefault();
                fileInput.style.borderColor = '#4F46E5';
                fileInput.style.background = '#eef2ff';
            });
            fileRow.addEventListener('dragleave', function() {
                fileInput.style.borderColor = '#e0ddd7';
                fileInput.style.background = '#faf9f7';
            });
            fileRow.addEventListener('drop', function(e) {
                e.preventDefault();
                fileInput.style.borderColor = '#e0ddd7';
                fileInput.style.background = '#faf9f7';
                if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
                    fileInput.files = e.dataTransfer.files;
                    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            uploadDiv.appendChild(fileRow);

            // Text fields (name, email, subject)
            var textInputs = {};
            (c.fields || []).forEach(function(f) {
                var row = document.createElement('div');
                row.style.cssText = 'margin-bottom:10px';
                var label = document.createElement('label');
                label.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#57534e;margin-bottom:4px';
                label.textContent = f.label;
                row.appendChild(label);
                if (f.editable === false) {
                    // Read-only field (e.g. subject)
                    var readOnly = document.createElement('div');
                    readOnly.style.cssText = 'font-size:12px;padding:8px 10px;border:1px solid #e7e5e0;border-radius:6px;background:#f4f2ef;color:#78716c';
                    readOnly.textContent = f.value || '';
                    row.appendChild(readOnly);
                    textInputs[f.key] = { value: f.value || '' };
                } else {
                    var input = document.createElement('input');
                    input.type = f.type || 'text';
                    input.value = f.value || '';
                    input.placeholder = f.label + '...';
                    input.style.cssText = 'display:block;width:100%;font-size:12px;padding:8px 10px;border:1px solid #e0ddd7;border-radius:6px;background:#fff';
                    row.appendChild(input);
                    textInputs[f.key] = input;
                }
                uploadDiv.appendChild(row);
            });

            // Optional additional info
            var infoRow = document.createElement('div');
            infoRow.style.cssText = 'margin-bottom:10px';
            var infoLabel = document.createElement('label');
            infoLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#57534e;margin-bottom:4px';
            infoLabel.textContent = 'Zusätzliche Informationen (optional)';
            infoRow.appendChild(infoLabel);
            var infoTextarea = document.createElement('textarea');
            infoTextarea.rows = 3;
            infoTextarea.placeholder = 'z.B. Bestellnummer, Anmerkungen...';
            infoTextarea.style.cssText = 'display:block;width:100%;font-size:12px;padding:8px 10px;border:1px solid #e0ddd7;border-radius:6px;background:#fff;resize:vertical';
            infoRow.appendChild(infoTextarea);
            uploadDiv.appendChild(infoRow);

            // Inline error display helper — highlights the EXACT missing field:
            // strong red border + tinted background + shake, and the first
            // errored field is scrolled into view and focused so it can't be
            // missed even when it sits above the fold of a long form.
            var errorEls = {};
            function fieldContainer(key) {
                if (key === 'form_type') return radioGroup;
                if (key === 'file') return fileRow;
                return textInputs[key] ? textInputs[key].parentNode : null;
            }
            function shake(el) {
                if (!el) return;
                el.style.animation = 'none';
                // force reflow so the animation restarts on repeated submits
                void el.offsetWidth;
                el.style.animation = 'vtx-shake 0.4s ease';
            }
            function showFieldError(key, msg) {
                if (!errorEls[key]) {
                    var errEl = document.createElement('div');
                    errEl.setAttribute('role', 'alert');
                    errEl.style.cssText = 'font-size:11px;font-weight:600;color:#dc2626;margin-top:4px;padding:3px 6px;background:#fef2f2;border-radius:4px;display:flex;align-items:center;gap:4px';
                    if (key === 'form_type') { radioGroup.appendChild(errEl); }
                    else if (key === 'file') { fileRow.appendChild(errEl); }
                    else if (textInputs[key] && textInputs[key].parentNode) { textInputs[key].parentNode.appendChild(errEl); }
                    errorEls[key] = errEl;
                }
                errorEls[key].textContent = '\u26A0\uFE0F ' + msg;
                errorEls[key].style.display = 'flex';
                if (key === 'form_type') {
                    radioGroup.querySelectorAll('label').forEach(function(l) { l.style.borderColor = '#dc2626'; l.style.background = '#fef2f2'; });
                } else if (key === 'file') {
                    fileInput.style.borderColor = '#dc2626'; fileInput.style.background = '#fef2f2';
                    fileInput.setAttribute('aria-invalid', 'true');
                } else if (textInputs[key] && textInputs[key].style) {
                    textInputs[key].style.borderColor = '#dc2626'; textInputs[key].style.background = '#fef2f2';
                    textInputs[key].setAttribute('aria-invalid', 'true');
                }
                shake(fieldContainer(key));
            }
            function clearFieldError(key) {
                if (errorEls[key]) { errorEls[key].style.display = 'none'; }
                if (key === 'form_type') {
                    radioGroup.querySelectorAll('label').forEach(function(l) { l.style.borderColor = '#e0ddd7'; l.style.background = '#fff'; });
                } else if (key === 'file') {
                    fileInput.style.borderColor = '#e0ddd7'; fileInput.style.background = '#faf9f7';
                    fileInput.removeAttribute('aria-invalid');
                } else if (textInputs[key] && textInputs[key].style) {
                    textInputs[key].style.borderColor = '#e0ddd7'; textInputs[key].style.background = '#fff';
                    textInputs[key].removeAttribute('aria-invalid');
                }
            }
            function clearAllErrors() { Object.keys(errorEls).forEach(function(k) { clearFieldError(k); }); }
            // Clear errors on input
            Object.keys(textInputs).forEach(function(key) {
                var el = textInputs[key];
                if (el && el.addEventListener) { el.addEventListener('input', function() { clearFieldError(key); }); }
            });
            fileInput.addEventListener('change', function() { clearFieldError('file'); if (typeof submitNotice !== 'undefined') submitNotice.style.display = 'none'; });

            // Submit button
            var submitBtn = document.createElement('button');
            submitBtn.style.cssText = 'width:100%;padding:10px;background:#2b2013;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:4px';
            submitBtn.textContent = 'Formular einreichen \u2192';
            // Notice next to the submit button — feedback exactly where the
            // customer clicked, pointing them at the highlighted fields above.
            var submitNotice = document.createElement('div');
            submitNotice.setAttribute('role', 'alert');
            submitNotice.style.cssText = 'display:none;margin-top:8px;padding:8px 10px;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;font-size:12px;font-weight:600;color:#b91c1c;text-align:center';

            submitBtn.addEventListener('click', async function() {
                clearAllErrors();
                submitNotice.style.display = 'none';
                var errKeys = [];
                if (!selectedType.value) { showFieldError('form_type', 'Bitte w\u00e4hle ein Formular aus.'); errKeys.push('form_type'); }
                if (!fileInput.files || !fileInput.files[0]) { showFieldError('file', 'Bitte lade eine PDF-Datei hoch.'); errKeys.push('file'); }
                else if (fileInput.files[0].size > 20 * 1024 * 1024) { showFieldError('file', 'Die Datei ist zu gro\u00df (max. 20 MB). Bitte verkleinere das PDF oder sende es an info@voltimax.de.'); errKeys.push('file'); }
                var nameVal = (textInputs['customer_name'] && textInputs['customer_name'].value) ? textInputs['customer_name'].value.trim() : '';
                if (!nameVal) { showFieldError('customer_name', 'Bitte gib deinen Namen ein.'); errKeys.push('customer_name'); }
                var emailVal = (textInputs['customer_email'] && textInputs['customer_email'].value) ? textInputs['customer_email'].value.trim() : '';
                if (!emailVal || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) { showFieldError('customer_email', 'Bitte gib eine g\u00fcltige E-Mail-Adresse ein.'); errKeys.push('customer_email'); }
                if (errKeys.length) {
                    submitNotice.textContent = errKeys.length === 1
                        ? 'Ein Pflichtfeld fehlt noch \u2014 siehe rote Markierung oben.'
                        : errKeys.length + ' Pflichtfelder fehlen noch \u2014 siehe rote Markierungen oben.';
                    submitNotice.style.display = 'block';
                    // Bring the FIRST missing field into view and focus it
                    var firstEl = fieldContainer(errKeys[0]);
                    if (firstEl && firstEl.scrollIntoView) {
                        firstEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                    if (textInputs[errKeys[0]]) { textInputs[errKeys[0]].focus({ preventScroll: true }); }
                    return;
                }

                submitBtn.disabled = true;
                submitBtn.textContent = 'Wird hochgeladen...';
                submitBtn.style.opacity = '0.7';

                var formData = new FormData();
                formData.append('file', fileInput.files[0]);
                formData.append('form_type', selectedType.value);
                formData.append('customer_name', nameVal);
                formData.append('customer_email', emailVal);
                formData.append('session_id', self._sessionId || '');
                formData.append('additional_info', infoTextarea.value || '');

                try {
                    var serverUrl = self.config.serverBUrl || 'http://localhost:8000';
                    var resp = await fetch(serverUrl + '/api/chat/batteriepfand-upload', { method: 'POST', body: formData });

                    // The proxy rejects oversized bodies with an HTML 413 page
                    // BEFORE our API runs — resp.json() would throw and the
                    // customer only saw a generic retry-bait failure
                    // (prod chat #D4D0E5D4: "immer FEHLGESCHLAGEN").
                    if (resp.status === 413) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Formular einreichen \u2192';
                        submitBtn.style.opacity = '1';
                        showFieldError('file', 'Die Datei ist zu gro\u00df f\u00fcr den Upload. Bitte verkleinere das PDF oder sende es an info@voltimax.de.');
                        submitNotice.textContent = 'Die Datei ist zu gro\u00df \u2014 bitte verkleinern und erneut versuchen.';
                        submitNotice.style.display = 'block';
                        return;
                    }
                    var result;
                    try {
                        result = await resp.json();
                    } catch (parseErr) {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Formular einreichen \u2192';
                        submitBtn.style.opacity = '1';
                        submitNotice.textContent = 'Der Server konnte den Upload nicht verarbeiten (Fehler ' + resp.status + '). Bitte sp\u00e4ter erneut versuchen oder das Formular an info@voltimax.de senden.';
                        submitNotice.style.display = 'block';
                        return;
                    }

                    if (result.success) {
                        while (uploadDiv.firstChild) uploadDiv.removeChild(uploadDiv.firstChild);
                        var done = document.createElement('div');
                        done.style.cssText = 'text-align:center;padding:16px';

                        var checkIcon = document.createElement('div');
                        checkIcon.style.cssText = 'font-size:28px;margin-bottom:8px';
                        checkIcon.textContent = '\u2705';
                        done.appendChild(checkIcon);

                        var doneText = document.createElement('div');
                        doneText.style.cssText = 'color:#16a34a;font-weight:600;font-size:14px;margin-bottom:12px';
                        doneText.textContent = 'Batteriepfand eingereicht!';
                        done.appendChild(doneText);

                        var ticketRow = document.createElement('div');
                        ticketRow.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:8px 14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px';

                        var ticketLabel = document.createElement('span');
                        ticketLabel.style.cssText = 'font-size:13px;color:#57534e';
                        ticketLabel.textContent = 'Ticket #' + result.ticket_id;
                        ticketRow.appendChild(ticketLabel);

                        var copyBtn = document.createElement('button');
                        copyBtn.style.cssText = 'padding:4px 10px;font-size:11px;border:1px solid #e0ddd7;border-radius:6px;background:#fff;cursor:pointer;color:#57534e';
                        copyBtn.textContent = '\uD83D\uDCCB Kopieren';
                        copyBtn.addEventListener('click', function() {
                            navigator.clipboard.writeText(result.ticket_id).then(function() {
                                copyBtn.textContent = '\u2713 Kopiert!';
                                copyBtn.style.borderColor = '#22c55e';
                                copyBtn.style.color = '#16a34a';
                                setTimeout(function() {
                                    copyBtn.textContent = '\uD83D\uDCCB Kopieren';
                                    copyBtn.style.borderColor = '#e0ddd7';
                                    copyBtn.style.color = '#57534e';
                                }, 2000);
                            });
                        });
                        ticketRow.appendChild(copyBtn);
                        done.appendChild(ticketRow);

                        uploadDiv.appendChild(done);
                        self._addMessage('ai', 'Dein Batteriepfand wurde erfolgreich eingereicht! Ticket **#' + result.ticket_id + '** wurde erstellt. Unser Team wird sich bei dir melden.');
                    } else {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Formular einreichen \u2192';
                        submitBtn.style.opacity = '1';
                        if (result.field_errors) {
                            Object.keys(result.field_errors).forEach(function(key) { showFieldError(key, result.field_errors[key]); });
                        } else if (result.error) {
                            self._addMessage('ai', '\u26a0\ufe0f ' + result.error);
                        }
                    }
                } catch (err) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Formular einreichen \u2192';
                    submitBtn.style.opacity = '1';
                    self._addMessage('ai', '\u26a0\ufe0f Upload fehlgeschlagen. Bitte versuche es erneut.');
                }
            });
            uploadDiv.appendChild(submitBtn);
            uploadDiv.appendChild(submitNotice);

            el.appendChild(uploadDiv);
        }

        // Primary action buttons
        if (c.actions && c.actions.length > 0) {
            var actionsDiv = document.createElement('div');
            actionsDiv.className = 'vtx-info-card__actions';
            actionsDiv.style.cssText = 'flex-wrap:wrap;gap:4px;padding:8px 12px;border-top:1px solid #f4f2ef';
            c.actions.forEach(function(action) {
                var btn = document.createElement('button');
                btn.className = 'vtx-choice-btn';
                btn.textContent = action;
                btn.addEventListener('click', function() {
                    self._addMessage('user', action);
                    if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                        self.ws.send(JSON.stringify({ type: 'message', content: action }));
                        self._showTypingIndicator();
                    }
                });
                actionsDiv.appendChild(btn);
            });
            el.appendChild(actionsDiv);
        }

        // Meta actions (secondary style)
        if (c.meta_actions && c.meta_actions.length > 0) {
            var metaDiv = document.createElement('div');
            metaDiv.className = 'vtx-info-card__actions';
            metaDiv.style.cssText = 'border-top:1px solid #f4f2ef;padding-top:8px';
            c.meta_actions.forEach(function(action) {
                var btn = document.createElement('button');
                btn.className = 'vtx-choice-btn vtx-choice-btn--secondary';
                btn.textContent = action;
                btn.addEventListener('click', function() {
                    if (action.toLowerCase().indexOf('another order') !== -1 || action.toLowerCase().indexOf('different order') !== -1) {
                        el.remove();
                        if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                            self.ws.send(JSON.stringify({ type: 'message', content: 'I want to look up a different order' }));
                            self._showTypingIndicator();
                        }
                        self._renderInputPrompt({
                            field: 'order_verify',
                            label: 'Look up a different order',
                            fields: [
                                { name: 'order_number', label: 'Order number', placeholder: '#...', type: 'text' },
                                { name: 'postcode', label: 'Billing postcode', placeholder: 'e.g. 10115', type: 'text' },
                            ],
                            action: 'verify_order',
                        });
                    } else if (action.toLowerCase().indexOf('try again') !== -1) {
                        el.remove();
                        if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                            self.ws.send(JSON.stringify({ type: 'message', content: 'Yes, I have it' }));
                            self._showTypingIndicator();
                        }
                    } else if (action.toLowerCase().indexOf('contact support') !== -1) {
                        if (self.config.contactFormUrl) {
                            window.open(self.config.contactFormUrl, '_blank');
                        } else {
                            self._addMessage('user', 'I need to speak with support');
                            if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                                self.ws.send(JSON.stringify({ type: 'message', content: 'I need to speak with support' }));
                                self._showTypingIndicator();
                            }
                        }
                    } else {
                        self._addMessage('user', action);
                        if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                            self.ws.send(JSON.stringify({ type: 'message', content: action }));
                            self._showTypingIndicator();
                        }
                    }
                });
                metaDiv.appendChild(btn);
            });
            el.appendChild(metaDiv);
        }

        return el;
    }

    _renderSuggestions(suggestions) {
        const chatWindow = document.querySelector('.voltimax-chat-window');
        if (!chatWindow) return;

        // Remove existing suggestions
        chatWindow.querySelectorAll('.vtx-suggestions-wrap, .vtx-suggestions, .voltimax-chat-quickreplies').forEach(el => el.remove());

        if (!suggestions || suggestions.length === 0) return;

        const self = this;

        // Wrapper with collapse toggle
        const wrap = document.createElement('div');
        wrap.className = 'vtx-suggestions-wrap';
        wrap.style.position = 'relative';

        // Toggle tab (sits above the bar)
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'vtx-suggestions-toggle';
        toggleBtn.innerHTML = '\u25BC';
        toggleBtn.title = 'Hide suggestions';
        let collapsed = false;
        toggleBtn.addEventListener('click', () => {
            collapsed = !collapsed;
            wrap.classList.toggle('vtx-suggestions-wrap--collapsed', collapsed);
            toggleBtn.innerHTML = collapsed ? '\u25B2' : '\u25BC';
            toggleBtn.title = collapsed ? 'Show suggestions' : 'Hide suggestions';
        });
        wrap.appendChild(toggleBtn);

        // Horizontal scrollable row
        const scrollRow = document.createElement('div');
        scrollRow.className = 'vtx-suggestions-scroll';

        suggestions.forEach(text => {
            const chip = document.createElement('button');
            chip.className = 'vtx-suggestion-chip';
            chip.textContent = text;
            chip.addEventListener('click', () => {
                self._addMessage('user', text);
                if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                    self.ws.send(JSON.stringify({ type: 'message', content: text }));
                    self._showTypingIndicator();
                }
            });
            scrollRow.appendChild(chip);
        });

        wrap.appendChild(scrollRow);

        // Insert before input area
        const inputArea = chatWindow.querySelector('.voltimax-chat-window__input-area');
        if (inputArea) {
            chatWindow.insertBefore(wrap, inputArea);
        } else {
            chatWindow.appendChild(wrap);
        }
    }

    // ── Markdown renderer ─────────────────────────────────────────────────────

    _buildMessageNodes(text) {
        // XSS-safe: all text content set via textContent, never innerHTML.
        // Only structural elements use createElement.
        const fragment = document.createDocumentFragment();

        const applyInline = (parent, str) => {
            const parts = str.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\n]+\)|https?:\/\/[^\s<>"')\]]+)/g);
            parts.forEach((part) => {
                if (/^https?:\/\//i.test(part)) {
                    // Bare URL — auto-link. Trailing sentence punctuation stays as text.
                    let url = part, trail = '';
                    const punct = url.match(/[.,;:!?]+$/);
                    if (punct) { trail = punct[0]; url = url.slice(0, -trail.length); }
                    const a = document.createElement('a');
                    let label = url.replace(/^https?:\/\/(www\.)?/i, '');
                    if (label.length > 40) label = label.slice(0, 37) + '…';
                    a.textContent = label;
                    a.href = this._safeUrl(url);
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    a.className = 'voltimax-chat-link';
                    parent.appendChild(a);
                    if (trail) parent.appendChild(document.createTextNode(trail));
                } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                    const strong = document.createElement('strong');
                    applyInline(strong, part.slice(2, -2));
                    parent.appendChild(strong);
                } else if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
                    const em = document.createElement('em');
                    applyInline(em, part.slice(1, -1));
                    parent.appendChild(em);
                } else if (part.startsWith('[')) {
                    const m = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
                    if (m) {
                        const label = m[1], url = m[2];
                        const carrierDomains = ['dhl.de', 'dpd.de', 'ups.com', 'gls-group.com', 'hermes.de', 'fedex.com'];
                        let isTracking = false;
                        try { isTracking = carrierDomains.some(d => new URL(url).hostname.includes(d)); } catch (_) {}

                        if (isTracking) {
                            const chip = document.createElement('span');
                            chip.className = 'voltimax-chat-tracking';

                            const a = document.createElement('a');
                            // Safe: hardcoded SVG, label set via textContent
                            a.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
                            a.appendChild(document.createTextNode(' ' + label));
                            a.href = url;
                            a.target = '_blank';
                            a.rel = 'noopener noreferrer';
                            a.className = 'voltimax-chat-tracking__link';
                            chip.appendChild(a);

                            const copyBtn = document.createElement('button');
                            copyBtn.className = 'voltimax-chat-tracking__copy';
                            copyBtn.setAttribute('aria-label', 'Sendungsnummer kopieren');
                            copyBtn.setAttribute('title', 'Kopieren');
                            // Safe: hardcoded SVG
                            copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
                            copyBtn.addEventListener('click', () => {
                                navigator.clipboard.writeText(label).then(() => {
                                    copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
                                    setTimeout(() => {
                                        copyBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
                                    }, 1800);
                                });
                            });
                            chip.appendChild(copyBtn);
                            parent.appendChild(chip);
                        } else {
                            const a = document.createElement('a');
                            a.textContent = label;
                            a.href = url;
                            a.target = '_blank';
                            a.rel = 'noopener noreferrer';
                            a.className = 'voltimax-chat-link';
                            parent.appendChild(a);
                        }
                    } else {
                        parent.appendChild(document.createTextNode(part));
                    }
                } else if (part) {
                    parent.appendChild(document.createTextNode(part));
                }
            });
        };

        const blocks = text.split(/\n{2,}/);

        blocks.forEach((block) => {
            if (!block.trim()) return;

            const lines = block.split('\n');
            let currentList = null, currentListType = null;

            const closeList = () => {
                if (currentList) fragment.appendChild(currentList);
                currentList = null;
                currentListType = null;
            };

            const pendingLines = [];

            const flushPending = () => {
                if (!pendingLines.length) return;
                const p = document.createElement('p');
                pendingLines.forEach((ln, i) => {
                    applyInline(p, ln);
                    if (i < pendingLines.length - 1) p.appendChild(document.createElement('br'));
                });
                fragment.appendChild(p);
                pendingLines.length = 0;
            };

            lines.forEach((line) => {
                const hMatch = line.match(/^#{1,4}\s+(.+)/);
                if (hMatch) {
                    flushPending();
                    closeList();
                    const h = document.createElement('p');
                    h.className = 'vtx-msg-heading';
                    const strong = document.createElement('strong');
                    applyInline(strong, hMatch[1]);
                    h.appendChild(strong);
                    fragment.appendChild(h);
                    return;
                }

                const ulMatch = line.match(/^[-*]\s+(.+)/);
                const olMatch = line.match(/^\d+\.\s+(.+)/);

                if (ulMatch) {
                    flushPending();
                    if (currentListType !== 'ul') { closeList(); currentList = document.createElement('ul'); currentListType = 'ul'; }
                    const li = document.createElement('li');
                    applyInline(li, ulMatch[1]);
                    currentList.appendChild(li);
                } else if (olMatch) {
                    flushPending();
                    if (currentListType !== 'ol') { closeList(); currentList = document.createElement('ol'); currentListType = 'ol'; }
                    const li = document.createElement('li');
                    applyInline(li, olMatch[1]);
                    currentList.appendChild(li);
                } else {
                    closeList();
                    if (line.trim()) pendingLines.push(line);
                }
            });

            flushPending();
            closeList();
        });

        return fragment;
    }
}
