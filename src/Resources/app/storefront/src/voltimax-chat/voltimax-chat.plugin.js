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
        this._inputLocked       = false;

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

    _saveSession() {
        try {
            var data = {
                chatId: this._chatId,
                sessionId: this._sessionId,
                state: this.state,
                topic: this.currentTopic || this._currentTopicId,
                token: this.token,
                config: this.config,
                customerContext: this.customerContext,
                messages: [],
            };
            // Save visible messages
            var msgEls = document.querySelectorAll('.voltimax-chat-message');
            msgEls.forEach(function(el) {
                var role = el.classList.contains('voltimax-chat-message--user') ? 'user' : 'ai';
                data.messages.push({ role: role, html: el.innerHTML });
            });
            sessionStorage.setItem('voltimax_chat_session', JSON.stringify(data));
        } catch (e) { /* silent */ }
    }

    _restoreSession() {
        try {
            var raw = sessionStorage.getItem('voltimax_chat_session');
            if (!raw) return false;
            var data = JSON.parse(raw);
            if (!data.sessionId || !data.token || !data.config) return false;

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

            // Restore messages
            var messages = document.querySelector('.voltimax-chat-window__messages');
            if (messages && data.messages && data.messages.length) {
                var self = this;
                data.messages.forEach(function(msg) {
                    if (msg.role === 'user') {
                        var row = document.createElement('div');
                        row.className = 'voltimax-chat-message voltimax-chat-message--user';
                        row.innerHTML = msg.html;
                        messages.appendChild(row);
                    } else {
                        var aiRow = document.createElement('div');
                        aiRow.className = 'voltimax-chat-ai-row';
                        var avatarEl = document.createElement('div');
                        avatarEl = self._buildAvatarEl();
                        var rowBody = document.createElement('div');
                        rowBody.className = 'voltimax-chat-ai-row__body';
                        var bubble = document.createElement('div');
                        bubble.className = 'voltimax-chat-message voltimax-chat-message--ai';
                        bubble.innerHTML = msg.html;
                        rowBody.appendChild(bubble);
                        aiRow.appendChild(avatarEl);
                        aiRow.appendChild(rowBody);
                        messages.appendChild(aiRow);
                    }
                });
                messages.scrollTop = messages.scrollHeight;
            }

            // Check if last message was from user (AI response was interrupted)
            var lastMsg = data.messages && data.messages.length ? data.messages[data.messages.length - 1] : null;
            if (lastMsg && lastMsg.role === 'user') {
                this._pendingResend = lastMsg.html;
            }

            // Reconnect WebSocket
            this.state = 'CHATTING';
            this._connectToServerB(data.topic || 'general');

            return true;
        } catch (e) {
            return false;
        }
    }

    _clearSession() {
        try { sessionStorage.removeItem('voltimax_chat_session'); } catch (e) { /* silent */ }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _buildAvatarEl() {
        var el = document.createElement('div');
        el.className = 'voltimax-chat-ai-row__avatar';
        if (this.config && this.config.logoUrl) {
            el.innerHTML = '<img src="' + this.config.logoUrl + '" alt="Groot" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
        } else {
            el.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><path d="M12 8v4"/><path d="M8 12c0 0-1 4 0 7 .5 1.5 2 3 4 3s3.5-1.5 4-3c1-3 0-7 0-7"/><path d="M9 14c-2-1-4 0-4 2"/><path d="M15 14c2-1 4 0 4 2"/><path d="M10 18c-.5 1-1 2.5-1 2.5"/><path d="M14 18c.5 1 1 2.5 1 2.5"/></svg>';
        }
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
            // Session restored — render bubble but hide it (widget is open)
            this._renderBubble();
            if (this._bubbleEl) this._bubbleEl.style.display = 'none';
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
        });
    }

    _renderBubble() {
        const bubble = document.createElement('div');
        bubble.className = 'voltimax-chat-bubble voltimax-chat-bubble--' + this.config.widgetPosition;
        bubble.style.setProperty('--vtx-primary', this.config.primaryColor);

        const btn = document.createElement('button');
        btn.className = 'voltimax-chat-bubble__button';
        btn.setAttribute('aria-label', 'Open chat');
        // Safe: hardcoded SVG
        btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';

        const badge = document.createElement('span');
        badge.className = 'voltimax-chat-bubble__badge';
        badge.style.display = 'none';
        badge.textContent = '0';
        btn.appendChild(badge);

        btn.addEventListener('click', () => this._onBubbleClick());
        bubble.appendChild(btn);
        document.body.appendChild(bubble);
        this._bubbleEl = bubble;
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
        expandBtn.setAttribute('aria-label', 'Expand');
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
        minBtn.setAttribute('aria-label', 'Minimize');
        minBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14"/></svg>';
        minBtn.addEventListener('click', () => this._minimize());
        actions.appendChild(minBtn);

        const closeBtn = document.createElement('button');
        closeBtn.setAttribute('aria-label', 'Close');
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
            widget.classList.toggle('voltimax-chat-widget--dark', dark);
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

        // Welcome — Groot avatar + greeting
        const welcomeWrap = document.createElement('div');
        welcomeWrap.className = 'vtx-home__welcome';

        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'vtx-home__avatar';
        if (this.config.logoUrl) {
            var logoImg = document.createElement('img');
            logoImg.src = this.config.logoUrl;
            logoImg.alt = 'Groot';
            logoImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
            avatarWrap.appendChild(logoImg);
        } else {
            avatarWrap.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="3"/><path d="M12 8v4"/><path d="M8 12c0 0-1 4 0 7 .5 1.5 2 3 4 3s3.5-1.5 4-3c1-3 0-7 0-7"/><path d="M9 14c-2-1-4 0-4 2"/><path d="M15 14c2-1 4 0 4 2"/><path d="M10 18c-.5 1-1 2.5-1 2.5"/><path d="M14 18c.5 1 1 2.5 1 2.5"/></svg>';
        }

        const avatarName = document.createElement('div');
        avatarName.className = 'vtx-home__avatar-name';
        avatarName.textContent = 'Groot';

        const welcomeSub = document.createElement('div');
        welcomeSub.className = 'vtx-home__welcome-sub';
        welcomeSub.textContent = 'Dein KI-Assistent f\u00fcr Voltimax';

        welcomeWrap.appendChild(avatarWrap);
        welcomeWrap.appendChild(avatarName);
        welcomeWrap.appendChild(welcomeSub);
        container.appendChild(welcomeWrap);

        // Returning user — show continue/new chat choice
        if (savedUser && savedUser.name) {
            const firstName = (savedUser.name || '').split(' ')[0] || savedUser.name;

            const resumeBar = document.createElement('div');
            resumeBar.className = 'vtx-resume-bar';

            const resumeText = document.createElement('div');
            resumeText.className = 'vtx-resume-bar__info';
            resumeText.textContent = 'Welcome back, ' + firstName + '!';
            resumeBar.appendChild(resumeText);

            const resumeActions = document.createElement('div');
            resumeActions.className = 'vtx-resume-bar__actions';

            const continueBtn = document.createElement('button');
            continueBtn.className = 'vtx-resume-bar__btn vtx-resume-bar__btn--primary';
            continueBtn.textContent = 'Continue';
            continueBtn.addEventListener('click', () => {
                resumeBar.remove();
            });

            const newChatBtn2 = document.createElement('button');
            newChatBtn2.className = 'vtx-resume-bar__btn vtx-resume-bar__btn--secondary';
            newChatBtn2.textContent = 'New chat';
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
        sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

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

        // Smart suggestion chips — populated from server after auth, with defaults as fallback
        const suggestionsContainer = document.createElement('div');
        suggestionsContainer.className = 'vtx-home__suggestions';
        this._homeSuggestionsContainer = suggestionsContainer;

        // Show default suggestions immediately; server suggestions replace them after auth
        const defaultSuggestions = [
            '\uD83D\uDCE6 Bestellstatus',
            '\uD83D\uDD0B Produktsuche',
            '\uD83D\uDE97 Fahrzeug-Batterie',
            '\u21A9\uFE0F Retoure & Erstattung',
            '\uD83D\uDE9A Versand & Lieferzeit',
            '\uD83E\uDDFE Rechnung anfordern',
            '\u267B\uFE0F Batteriepfand',
            '\uD83C\uDFAB Ticket-Status',
            '\uD83D\uDCC4 R\u00fcckgaberecht',
            '\uD83D\uDCAC Support kontaktieren',
            '\uD83D\uDCB3 Zahlungsstatus',
            '\uD83D\uDD12 Mein Konto',
            '\u26A0\uFE0F Problem melden',
            '\uD83D\uDD0C Zubeh\u00f6r',
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
        suggestions.forEach(text => {
            const chip = document.createElement('button');
            chip.className = 'vtx-topic-chip';
            chip.textContent = text;
            chip.addEventListener('click', () => {
                inputEl.value = text;
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
            icon.textContent = t.icon || '\uD83D\uDCAC';
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
        title.textContent = 'To look up your order:';
        form.appendChild(title);

        const fields = document.createElement('div');
        fields.className = 'vtx-verify-form__fields';

        const orderInput = document.createElement('input');
        orderInput.className = 'vtx-verify-form__input';
        orderInput.type = 'text';
        orderInput.placeholder = 'Order #';
        orderInput.required = true;

        const postcodeInput = document.createElement('input');
        postcodeInput.className = 'vtx-verify-form__input';
        postcodeInput.type = 'text';
        postcodeInput.placeholder = 'Postcode';
        postcodeInput.required = true;

        fields.appendChild(orderInput);
        fields.appendChild(postcodeInput);
        form.appendChild(fields);

        const submitBtn = document.createElement('button');
        submitBtn.className = 'vtx-verify-form__submit';
        submitBtn.textContent = 'Look up \u2192';
        form.appendChild(submitBtn);

        const errorDiv = document.createElement('div');
        errorDiv.className = 'vtx-verify-form__error';
        form.appendChild(errorDiv);

        const doSubmit = () => {
            const orderNum = orderInput.value.trim();
            const postcode = postcodeInput.value.trim();

            if (!orderNum || !postcode) {
                errorDiv.textContent = 'Please enter order number and postcode.';
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Looking up...';
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
                            submitBtn.textContent = 'Look up \u2192';
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
                        errorDiv.textContent = 'Verification failed. Please try again.';
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Look up \u2192';
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
        title.textContent = 'To access your account:';
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
        emailInput.placeholder = 'Your email';
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
        submitBtn.textContent = 'Continue \u2192';
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
            submitBtn.textContent = 'Verifying...';
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
                            errorDiv.textContent = 'Verification failed. Please try again.';
                            const btn = document.querySelector('.vtx-verify-form__submit');
                            if (btn) { btn.disabled = false; btn.textContent = 'Continue \u2192'; }
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
                        errorDiv.textContent = 'Verification failed. Please try again.';
                        const btn = document.querySelector('.vtx-verify-form__submit');
                        if (btn) { btn.disabled = false; btn.textContent = 'Continue \u2192'; }
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
                id: 'orders', title: 'Orders', icon: '\uD83D\uDCE6',
                description: 'Track, return or report issues',
                tier: 2,
                sub_cards: [
                    { id: 'order_status', title: 'Track Shipment', icon: '\uD83D\uDE9A' },
                    { id: 'returns', title: 'Return / Refund', icon: '\u21A9\uFE0F' },
                    { id: 'order_issue', title: 'Order Problem', icon: '\u26A0\uFE0F' },
                ],
            },
            {
                id: 'products', title: 'Products', icon: '\uD83D\uDECD\uFE0F',
                description: 'Find the right product',
                tier: 0,
                sub_cards: [
                    { id: 'product_help', title: 'Product Question', icon: '\u2753' },
                    { id: 'stock', title: 'Stock & Availability', icon: '\uD83D\uDCCA' },
                    { id: 'compatibility', title: 'Vehicle Compatibility', icon: '\uD83D\uDE97' },
                ],
            },
            {
                id: 'shipping', title: 'Shipping', icon: '\uD83D\uDE9B',
                description: 'Delivery times and options',
                tier: 0,
                sub_cards: [
                    { id: 'delivery_time', title: 'Delivery Times', icon: '\u23F1\uFE0F' },
                    { id: 'shipping_costs', title: 'Shipping Costs', icon: '\uD83D\uDCB0' },
                    { id: 'express_delivery', title: 'Express', icon: '\u26A1' },
                ],
            },
            {
                id: 'account', title: 'Account', icon: '\uD83D\uDC64',
                description: 'Payments, addresses, invoices',
                tier: 1,
                sub_cards: [
                    { id: 'payment', title: 'Payment', icon: '\uD83D\uDCB3' },
                    { id: 'address', title: 'Addresses', icon: '\uD83D\uDCCD' },
                    { id: 'invoice', title: 'Invoices', icon: '\uD83E\uDDFE' },
                ],
            },
            {
                id: 'others', title: 'More', icon: '\uD83D\uDCAC',
                description: 'FAQ, complaints, contact',
                tier: 1,
                sub_cards: [
                    { id: 'faq', title: 'FAQ', icon: '\uD83D\uDCD6' },
                    { id: 'complaint', title: 'Complaint', icon: '\uD83D\uDCE2' },
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
        messagesWrap.appendChild(messages);

        // Scroll-to-bottom button
        const scrollBtn = document.createElement('button');
        scrollBtn.className = 'voltimax-chat-scroll-btn';
        scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
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
        textarea.placeholder = 'Type a message...';
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
        sendBtn.setAttribute('aria-label', 'Send');
        // Safe: hardcoded SVG
        sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
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
        messagesWrap.appendChild(messages);

        const scrollBtn = document.createElement('button');
        scrollBtn.className = 'voltimax-chat-scroll-btn';
        scrollBtn.setAttribute('aria-label', 'Scroll to bottom');
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
        textarea.placeholder = 'Type a message...';
        textarea.rows = 1;
        textarea.addEventListener('input', () => {
            textarea.style.height = 'auto';
            textarea.style.height = Math.min(textarea.scrollHeight, 96) + 'px';
        });
        inputArea.appendChild(textarea);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'voltimax-chat-window__send btn btn-primary';
        sendBtn.setAttribute('aria-label', 'Send');
        sendBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';
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
        }
    }

    // ── Server B connection ───────────────────────────────────────────────────

    _connectToServerB(topicId) {
        if (!this.config.serverBUrl || !this.token) return;

        this._currentTopicId = topicId;
        const wsUrl = this.config.serverBUrl.replace(/^http/, 'ws') + '/ws/chat';
        try {
            this.ws = new WebSocket(wsUrl);
            this.ws.onopen = () => {
                this._reconnectAttempts = 0;
                clearTimeout(this._reconnectTimer);
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
                    }
                }, 500);
            }
        } else if (data.type === 'stream_chunk') {
            // Buffer tokens silently — show typing indicator instead of real-time streaming
            this._streamingRaw = (this._streamingRaw || '') + data.content;
            this._showTypingIndicator();
        } else if (data.type === 'stream_end') {
            // Remove typing indicator and show the full buffered message at once
            if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }

            const aiMessageId = data.message_id || null;
            const fullText = this._streamingRaw || '';
            this._streamingRaw = '';
            this._streamingRow = null;

            if (!aiMessageId) {
                // No message_id = discard signal (card response coming via ai_card type)
            } else if (fullText) {
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
            if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }
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
            if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }
            var messages = document.querySelector('.voltimax-chat-window__messages');
            if (!messages) {
                this._buildChatUI(this.currentTopic || 'general');
                messages = document.querySelector('.voltimax-chat-window__messages');
            }
            if (messages) {
                var aiMessageId = data.message_id || this._generateId();

                // Same row structure as _addMessage: avatar | rowBody
                var row = document.createElement('div');
                row.className = 'voltimax-chat-ai-row';

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
                messages.scrollTop = messages.scrollHeight;
            }
            if (this._minimized) this._incrementBadge();
            this._unlockInput();
            this._saveSession();
        } else if (data.type === 'typing') {
            this._showTypingIndicator();
        } else if (data.type === 'escalation') {
            this._showEscalation(data);
        } else if (data.type === 'play_sound') {
            this._playSound(data.message);
        } else if (data.type === 'confirmation_request' && data.confirmation) {
            this._showConfirmationCard(data.confirmation);
            this._unlockInput();
        } else if (data.type === 'choices' && data.choices) {
            this._renderChoices(data.message || '', data.choices);
        } else if (data.type === 'input_prompt' && data.input_prompt) {
            this._renderInputPrompt(data.input_prompt);
        } else if (data.type === 'info_card' && data.info_card) {
            this._renderInfoCard(data.info_card);
            this._unlockInput();
        } else if (data.type === 'suggestions' && data.suggestions) {
            this._renderSuggestions(data.suggestions);
        } else if (data.type === 'session_closed') {
            // Server closed the session (idle timeout, escalation, etc.)
            this._sessionClosed = true;
            this._reconnectAttempts = 999; // prevent auto-reconnect

            // Disable input
            var input = document.querySelector('.voltimax-chat-window__input input');
            if (input) {
                input.disabled = true;
                input.placeholder = 'Sitzung beendet';
            }
            var sendBtn = document.querySelector('.voltimax-chat-window__send-btn');
            if (sendBtn) sendBtn.disabled = true;

            // Show "Start new chat" button
            var messagesEl = document.querySelector('.voltimax-chat-window__messages');
            if (messagesEl) {
                var banner = document.createElement('div');
                banner.className = 'voltimax-chat-session-closed';
                banner.style.cssText = 'text-align:center;padding:12px 16px;margin:8px 0;background:#f5f5f5;border-radius:8px;font-size:13px;color:#666;';
                var reason = data.message === 'idle_timeout' ? 'Inaktivität' : 'Sitzung beendet';
                banner.innerHTML = '<div style="margin-bottom:8px;">Sitzung geschlossen (' + reason + ')</div>'
                    + '<button class="vtx-new-chat-btn" style="padding:6px 16px;border:1px solid #2196F3;background:#fff;color:#2196F3;border-radius:16px;cursor:pointer;font-size:13px;">Neuen Chat starten</button>';
                messagesEl.appendChild(banner);
                messagesEl.scrollTop = messagesEl.scrollHeight;

                banner.querySelector('.vtx-new-chat-btn').addEventListener('click', () => {
                    this._sessionClosed = false;
                    this._reconnectAttempts = 0;
                    this._resetChat();
                });
            }
        } else if (data.type === 'error') {
            var errMsg = data.message || 'An error occurred.';

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
        if (this._sessionClosed) return;

        // Auto-reconnect with exponential backoff (C3)
        if (this.state !== 'CHATTING' || !this._currentTopicId) return;
        const MAX_ATTEMPTS = 5;
        if (this._reconnectAttempts >= MAX_ATTEMPTS) return;

        const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
        this._reconnectAttempts++;
        this._reconnectTimer = setTimeout(() => {
            if (this.state === 'CHATTING') {
                this._connectToServerB(this._currentTopicId);
            }
        }, delay);
    }

    // ── Messages ──────────────────────────────────────────────────────────────

    _sendMessage(input) {
        const text = input.value.trim();
        if (!text || this._inputLocked) return;
        input.value = '';
        input.style.height = 'auto'; // reset auto-grow

        const qr = document.querySelector('.voltimax-chat-quickreplies');
        if (qr) qr.remove();

        const messageId = this._generateId();
        this._addMessage('user', text, messageId);

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'message', content: text }));
        }

        // Lock input while AI is processing
        this._lockInput();
    }

    _lockInput() {
        this._inputLocked = true;
        var input = document.querySelector('.voltimax-chat-window__input textarea, .voltimax-chat-window__input input');
        var sendBtn = document.querySelector('.voltimax-chat-window__send-btn');
        if (input) { input.disabled = true; input.placeholder = 'Groot denkt nach...'; }
        if (sendBtn) sendBtn.disabled = true;
        // Safety timeout — unlock after 30s if no response arrives
        if (this._lockTimer) clearTimeout(this._lockTimer);
        this._lockTimer = setTimeout(() => this._unlockInput(), 30000);
    }

    _unlockInput() {
        if (!this._inputLocked) return;
        this._inputLocked = false;
        if (this._lockTimer) { clearTimeout(this._lockTimer); this._lockTimer = null; }
        var input = document.querySelector('.voltimax-chat-window__input textarea, .voltimax-chat-window__input input');
        var sendBtn = document.querySelector('.voltimax-chat-window__send-btn');
        if (input) { input.disabled = false; input.placeholder = 'Schreib eine Nachricht...'; input.focus(); }
        if (sendBtn) sendBtn.disabled = false;
    }

    _addMessage(sender, content, messageId = null) {
        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) return null;

        // Finalize any active streaming bubble
        const streaming = messages.querySelector('.is-streaming');
        if (streaming) streaming.classList.remove('is-streaming');

        if (sender === 'ai') {
            // Update last user message status to "Read"
            if (this._lastUserStatusEl) {
                this._lastUserStatusEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/><polyline points="14 6 3 17"/></svg> Gelesen';
                this._lastUserStatusEl.classList.add('is-read');
                this._lastUserStatusEl = null;
            }

            const aiMessageId = messageId || this._generateId();

            // Row structure: avatar | [name + bubble + feedback]
            const row = document.createElement('div');
            row.className = 'voltimax-chat-ai-row';

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
            messages.scrollTop = messages.scrollHeight;

            if (this._minimized) this._incrementBadge();
            this._saveSession();

            return msg;
        } else {
            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;';

            // Customer name
            const customerName = (this.customerContext && this.customerContext.name) || '';
            if (customerName) {
                const nameEl = document.createElement('div');
                nameEl.style.cssText = 'font-size:11px;font-weight:700;color:#6366f1;padding-right:4px;margin-bottom:2px;';
                nameEl.textContent = customerName.split(' ')[0];
                wrapper.appendChild(nameEl);
            }

            const msg = document.createElement('div');
            msg.className = 'voltimax-chat-message voltimax-chat-message--user';
            msg.textContent = content;

            const timeEl = document.createElement('span');
            timeEl.className = 'voltimax-chat-message__time';
            timeEl.textContent = this._formatTime(new Date());
            msg.appendChild(timeEl);

            // Delivery status
            const statusEl = document.createElement('span');
            statusEl.className = 'voltimax-chat-message__status';
            statusEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> Gesendet';
            msg.appendChild(statusEl);
            this._lastUserStatusEl = statusEl;

            wrapper.appendChild(msg);
            messages.appendChild(wrapper);
            messages.scrollTop = messages.scrollHeight;
            this._saveSession();
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

        if (this._typingEl) {
            this._typingEl.remove();
            this._typingEl = null;
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
            this._lastUserStatusEl.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/><polyline points="14 6 3 17" opacity="0.4"/></svg> Zugestellt';
        }

        const messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages || messages.querySelector('.voltimax-chat-typing')) return;

        const typing = document.createElement('div');
        typing.className = 'voltimax-chat-typing';

        // Avatar — use uploaded logo or SVG fallback
        const avatarEl = this._buildAvatarEl();
        avatarEl.className = 'voltimax-chat-typing__avatar';
        typing.appendChild(avatarEl);

        // Bubble with text + dots
        const bubble = document.createElement('div');
        bubble.className = 'voltimax-chat-typing__bubble';

        const textEl = document.createElement('span');
        textEl.className = 'voltimax-chat-typing__text';
        textEl.textContent = 'Groot is typing';
        bubble.appendChild(textEl);

        const dotsEl = document.createElement('span');
        dotsEl.className = 'voltimax-chat-typing__dots';
        dotsEl.appendChild(document.createElement('span'));
        dotsEl.appendChild(document.createElement('span'));
        dotsEl.appendChild(document.createElement('span'));
        bubble.appendChild(dotsEl);

        typing.appendChild(bubble);
        messages.appendChild(typing);
        messages.scrollTop = messages.scrollHeight;

        this._typingEl = typing;
    }

    _showEscalation(data) {
        this._addMessage('ai', data.message || 'Would you like to speak with a team member?');
    }

    _buildConfirmationDOM(confirmation) {
        const card = document.createElement('div');
        card.className = 'voltimax-chat-confirm';

        // Header with icon and title
        const header = document.createElement('div');
        header.className = 'voltimax-chat-confirm__header';
        // Safe: hardcoded SVG (shield check icon)
        header.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
        const titleEl = document.createElement('span');
        titleEl.textContent = confirmation.title || 'Please Confirm';
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
                    input.type = field.type || 'text';
                    input.placeholder = field.label + ' *';
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
                    prefixEl.style.cssText = 'font-size:12px;font-weight:600;color:#6b7280;white-space:nowrap;padding:6px 4px 6px 10px;background:#f8f9fc;border:1px solid #e2e8f0;border-right:none;border-radius:8px 0 0 8px;';
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
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
            card.remove();
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'cancel_action', action: confirmation.action }));
            }
        });

        const confirmBtn = document.createElement('button');
        confirmBtn.className = 'voltimax-chat-confirm__btn voltimax-chat-confirm__btn--confirm';
        confirmBtn.textContent = 'Confirm \u2192';
        confirmBtn.addEventListener('click', () => {
            // Collect field values
            const fields = {};
            let hasEmpty = false;
            for (const [key, el] of Object.entries(fieldInputs)) {
                if (el instanceof HTMLElement) {
                    fields[key] = el.value;
                    // Validate required editable fields
                    if (!el.value.trim()) {
                        el.style.borderColor = '#ef4444';
                        hasEmpty = true;
                    } else {
                        el.style.borderColor = '';
                    }
                } else {
                    fields[key] = el.value;
                }
            }

            if (hasEmpty) {
                return; // Don't submit with empty fields
            }

            // Disable buttons, show loading
            confirmBtn.disabled = true;
            cancelBtn.disabled = true;
            confirmBtn.textContent = 'Processing...';

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'confirm_action',
                    action: confirmation.action,
                    fields: fields,
                }));
            }

            // Replace card with a confirmed status after short delay
            setTimeout(() => {
                card.className = 'voltimax-chat-confirm voltimax-chat-confirm--done';
                card.textContent = '';
                const doneMsg = document.createElement('div');
                doneMsg.className = 'voltimax-chat-confirm__done';
                doneMsg.textContent = '\u2713 Request confirmed and submitted';
                card.appendChild(doneMsg);
            }, 500);
        });

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);
        card.appendChild(actions);

        return card;
    }

    _showConfirmationCard(confirmation) {
        let messages = document.querySelector('.voltimax-chat-window__messages');
        if (!messages) {
            this._buildChatUI(this.currentTopic || 'general');
            messages = document.querySelector('.voltimax-chat-window__messages');
        }
        if (!messages) return;
        if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }
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
        if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }

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

        if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }

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
            submitBtn.textContent = 'Verifying...';
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

        if (this._typingEl) { this._typingEl.remove(); this._typingEl = null; }
        messages.querySelectorAll('.vtx-input-prompt').forEach(function(el) { el.remove(); });

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
            blue:   { bg: '#eff6ff', border: '#3b82f6', headerColor: '#1d4ed8' },
            amber:  { bg: '#fffbeb', border: '#f59e0b', headerColor: '#b45309' },
            red:    { bg: '#fef2f2', border: '#ef4444', headerColor: '#dc2626' },
            gray:   { bg: '#f8f9fa', border: '#6b7280', headerColor: '#374151' },
            purple: { bg: '#f5f3ff', border: '#8b5cf6', headerColor: '#6d28d9' },
        };

        // Normalize: convert legacy card types to dynamic format
        var c = card;
        if (card.card_type !== 'dynamic' && card.card_type !== 'close_chat' && card.card_type !== 'batteriepfand_upload') {
            c = Object.assign({}, card, card.data || {});
            if (!c.style) c.style = 'blue';
            if (!c.title && c.order_number) c.title = 'Order #' + c.order_number;
        }

        // Special: close chat card
        if (c.card_type === 'close_chat') {
            var closeEl = document.createElement('div');
            closeEl.style.cssText = 'border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;background:#fff;margin-bottom:6px';

            var closeHeader = document.createElement('div');
            closeHeader.style.cssText = 'padding:14px 16px;text-align:center;border-bottom:1px solid #f3f4f6';
            var closeIcon = document.createElement('div');
            closeIcon.style.cssText = 'font-size:24px;margin-bottom:6px';
            closeIcon.textContent = '\uD83D\uDC4B';
            closeHeader.appendChild(closeIcon);
            var closeTitle = document.createElement('div');
            closeTitle.style.cssText = 'font-size:14px;font-weight:600;color:#374151;margin-bottom:4px';
            closeTitle.textContent = c.title || 'Kann ich noch etwas f\u00fcr dich tun?';
            closeHeader.appendChild(closeTitle);
            if (c.description) {
                var closeDesc = document.createElement('div');
                closeDesc.style.cssText = 'font-size:12px;color:#6b7280';
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
            newBtn.style.cssText = 'flex:1;padding:10px;border:none;background:#3b82f6;color:#fff;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer';
            newBtn.textContent = 'Neuen Chat starten';
            newBtn.addEventListener('mouseenter', function() { newBtn.style.background = '#2563eb'; });
            newBtn.addEventListener('mouseleave', function() { newBtn.style.background = '#3b82f6'; });
            newBtn.addEventListener('click', function() {
                closeEl.remove();
                self._resetChat();
            });
            closeBtns.appendChild(newBtn);

            closeEl.appendChild(closeBtns);
            return closeEl;
        }

        var theme = themes[c.style] || themes.blue;

        var el = document.createElement('div');
        el.className = 'vtx-info-card';
        el.style.cssText = 'background:' + theme.bg + ' !important;border-color:' + theme.border;

        // Header
        if (c.title) {
            var header = document.createElement('div');
            header.className = 'vtx-info-card__header';
            header.style.color = theme.headerColor;
            header.textContent = (c.icon ? c.icon + ' ' : '') + c.title;
            el.appendChild(header);
        }

        // Rows grid
        if (c.rows && c.rows.length > 0) {
            var grid = document.createElement('div');
            grid.className = 'vtx-info-card__grid';
            c.rows.forEach(function(row) {
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
                    danger: 'color:#dc2626;font-weight:600',
                    muted: 'color:#9ca3af',
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
                    card.href = link.url || '#';
                    card.target = '_blank';
                    card.rel = 'noopener';
                    // GA4: track product click
                    (function(lnk, idx) {
                        card.addEventListener('click', function() {
                            self._trackProductClick(lnk, idx);
                        });
                    })(link, linkIndex++);

                    if (isAlt) {
                        card.style.cssText = 'display:block;text-decoration:none;padding:8px 12px;margin:-2px 0 6px 16px;border:1px solid #22c55e;border-radius:8px;background:' + theme.bg + ';transition:all 0.2s';
                        card.addEventListener('mouseenter', function() { card.style.borderColor = '#16a34a'; card.style.boxShadow = '0 2px 8px rgba(34,197,94,0.15)'; });
                        card.addEventListener('mouseleave', function() { card.style.borderColor = '#22c55e'; card.style.boxShadow = 'none'; });
                    } else {
                        card.style.cssText = 'display:block;text-decoration:none;padding:10px 12px;margin-bottom:6px;border:1px solid ' + theme.border + '30;border-radius:10px;background:' + theme.bg + ';transition:all 0.2s';
                        card.addEventListener('mouseenter', function() { card.style.borderColor = '#3b82f6'; card.style.boxShadow = '0 2px 8px rgba(59,130,246,0.15)'; });
                        card.addEventListener('mouseleave', function() { card.style.borderColor = theme.border + '30'; card.style.boxShadow = 'none'; });
                    }

                    var nameEl = document.createElement('div');
                    nameEl.style.cssText = 'font-size:' + (isAlt ? '12px' : '13px') + ';font-weight:600;color:#3b82f6;margin-bottom:4px;line-height:1.3';
                    nameEl.textContent = link.label;
                    card.appendChild(nameEl);

                    var lines = link.detail.split('\n');
                    lines.forEach(function(line) {
                        var lineEl = document.createElement('div');
                        lineEl.style.cssText = 'font-size:11px;color:' + theme.muted + ';line-height:1.4';
                        lineEl.textContent = line;
                        card.appendChild(lineEl);
                    });

                    linksDiv.appendChild(card);
                } else {
                    // Standard link (tracking, ticket copy, etc.)
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';

                    var a = document.createElement('a');
                    a.href = link.url || '#';
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
                        copyBtn.textContent = '\uD83D\uDCCB Copy';
                        var copyText = link.copy;
                        copyBtn.addEventListener('click', function() {
                            navigator.clipboard.writeText(copyText).then(function() {
                                copyBtn.textContent = '\u2713 Copied';
                                setTimeout(function() { copyBtn.textContent = '\uD83D\uDCCB Copy'; }, 1500);
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
            formDiv.style.cssText = 'padding:12px 16px;border-top:1px solid #f3f4f6';
            var formInputs = {};
            var cascadeUrl = c.form.cascade_url || null;
            var self = this;

            (c.form.fields || []).forEach(function(field) {
                var fieldRow = document.createElement('div');
                fieldRow.style.cssText = 'margin-bottom:8px';

                var label = document.createElement('label');
                label.style.cssText = 'display:block;font-size:11px;font-weight:600;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.03em';
                label.textContent = field.label;
                fieldRow.appendChild(label);

                var inputEl;
                if (field.type === 'select') {
                    // Dropdown select
                    inputEl = document.createElement('select');
                    inputEl.style.cssText = 'width:100%;padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box;background:#fff;appearance:auto';
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
                    inputEl.style.cssText = 'width:100%;padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:8px;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box';
                    inputEl.dataset.name = field.name;
                }

                fieldRow.appendChild(inputEl);
                formInputs[field.name] = inputEl;
                formDiv.appendChild(fieldRow);
            });

            var submitBtn = document.createElement('button');
            submitBtn.style.cssText = 'width:100%;padding:10px;background:var(--vtx-primary,#6366f1);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit';
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
            desc.style.cssText = 'padding:10px 16px;font-size:12px;color:#6b7280;border-top:1px solid #f3f4f6;white-space:pre-line';
            desc.textContent = c.description;
            el.appendChild(desc);
        }

        // Steps (full-width paragraphs — used by Batteriepfand)
        if (c.steps && c.steps.length > 0) {
            var stepsDiv = document.createElement('div');
            stepsDiv.style.cssText = 'padding:12px 16px;border-top:1px solid #f3f4f6';

            c.steps.forEach(function(step) {
                var stepEl = document.createElement('div');
                var isWarning = step.style === 'warning';
                stepEl.style.cssText = 'margin-bottom:12px;padding:10px 12px;border-radius:8px;background:' + (isWarning ? '#fefce8' : '#f9fafb') + ';border-left:3px solid ' + (isWarning ? '#f59e0b' : '#22c55e');

                var titleEl = document.createElement('div');
                titleEl.style.cssText = 'font-size:12px;font-weight:700;color:' + (isWarning ? '#92400e' : '#374151') + ';margin-bottom:4px';
                titleEl.textContent = step.title;
                stepEl.appendChild(titleEl);

                var textEl = document.createElement('div');
                textEl.style.cssText = 'font-size:12px;color:#6b7280;line-height:1.5';
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
            uploadDiv.style.cssText = 'padding:12px 16px;border-top:1px solid #f3f4f6';

            // Radio selector for form type
            var selectedType = { value: '' };
            var radioGroup = document.createElement('div');
            radioGroup.style.cssText = 'margin-bottom:12px';

            c.upload_options.forEach(function(opt) {
                var radioRow = document.createElement('label');
                radioRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;margin-bottom:4px;border:1px solid #d1d5db;border-radius:8px;cursor:pointer;transition:all 0.2s;font-size:13px;color:#374151';
                radioRow.addEventListener('mouseenter', function() { radioRow.style.borderColor = '#22c55e'; });
                radioRow.addEventListener('mouseleave', function() { if (selectedType.value !== opt.key) radioRow.style.borderColor = '#d1d5db'; });

                var radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'batteriepfand_type';
                radio.value = opt.key;
                radio.style.cssText = 'accent-color:#22c55e';
                radio.addEventListener('change', function() {
                    selectedType.value = opt.key;
                    radioGroup.querySelectorAll('label').forEach(function(l) { l.style.borderColor = '#d1d5db'; l.style.background = '#fff'; });
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
            fileLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px';
            fileLabel.textContent = 'PDF hochladen *';
            fileRow.appendChild(fileLabel);
            var fileInput = document.createElement('input');
            fileInput.type = 'file';
            fileInput.accept = '.pdf';
            fileInput.style.cssText = 'display:block;width:100%;font-size:12px;padding:6px;border:1px solid #d1d5db;border-radius:6px;background:#f9fafb';
            fileRow.appendChild(fileInput);
            uploadDiv.appendChild(fileRow);

            // Text fields (name, email)
            var textInputs = {};
            (c.fields || []).forEach(function(f) {
                var row = document.createElement('div');
                row.style.cssText = 'margin-bottom:10px';
                var label = document.createElement('label');
                label.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px';
                label.textContent = f.label;
                row.appendChild(label);
                var input = document.createElement('input');
                input.type = f.type || 'text';
                input.value = f.value || '';
                input.placeholder = f.label + '...';
                input.style.cssText = 'display:block;width:100%;font-size:12px;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff';
                row.appendChild(input);
                textInputs[f.key] = input;
                uploadDiv.appendChild(row);
            });

            // Optional additional info
            var infoRow = document.createElement('div');
            infoRow.style.cssText = 'margin-bottom:10px';
            var infoLabel = document.createElement('label');
            infoLabel.style.cssText = 'display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:4px';
            infoLabel.textContent = 'Zusätzliche Informationen (optional)';
            infoRow.appendChild(infoLabel);
            var infoTextarea = document.createElement('textarea');
            infoTextarea.rows = 3;
            infoTextarea.placeholder = 'z.B. Bestellnummer, Anmerkungen...';
            infoTextarea.style.cssText = 'display:block;width:100%;font-size:12px;padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;resize:vertical';
            infoRow.appendChild(infoTextarea);
            uploadDiv.appendChild(infoRow);

            // Submit button
            var submitBtn = document.createElement('button');
            submitBtn.style.cssText = 'width:100%;padding:10px;background:#22c55e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:4px';
            submitBtn.textContent = 'Formular einreichen \u2192';
            submitBtn.addEventListener('click', async function() {
                if (!selectedType.value) { alert('Bitte w\u00e4hle ein Formular aus.'); return; }
                if (!fileInput.files || !fileInput.files[0]) { alert('Bitte eine PDF-Datei hochladen.'); return; }

                submitBtn.disabled = true;
                submitBtn.textContent = 'Wird hochgeladen...';

                var formData = new FormData();
                formData.append('file', fileInput.files[0]);
                formData.append('form_type', selectedType.value);
                formData.append('customer_name', (textInputs['customer_name'] || {}).value || '');
                formData.append('customer_email', (textInputs['customer_email'] || {}).value || '');
                formData.append('session_id', self._sessionId || '');
                formData.append('additional_info', infoTextarea.value || '');

                try {
                    var serverUrl = self.config.serverBUrl || 'http://localhost:8000';
                    var resp = await fetch(serverUrl + '/api/chat/batteriepfand-upload', { method: 'POST', body: formData });
                    var result = await resp.json();

                    if (result.success) {
                        uploadDiv.innerHTML = '';
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
                        ticketLabel.style.cssText = 'font-size:13px;color:#374151';
                        ticketLabel.textContent = 'Ticket #' + result.ticket_id;
                        ticketRow.appendChild(ticketLabel);

                        var copyBtn = document.createElement('button');
                        copyBtn.style.cssText = 'padding:4px 10px;font-size:11px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;color:#374151';
                        copyBtn.textContent = '\uD83D\uDCCB Kopieren';
                        copyBtn.addEventListener('click', function() {
                            navigator.clipboard.writeText(result.ticket_id).then(function() {
                                copyBtn.textContent = '\u2713 Kopiert!';
                                copyBtn.style.borderColor = '#22c55e';
                                copyBtn.style.color = '#16a34a';
                                setTimeout(function() {
                                    copyBtn.textContent = '\uD83D\uDCCB Kopieren';
                                    copyBtn.style.borderColor = '#d1d5db';
                                    copyBtn.style.color = '#374151';
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
                        alert('Fehler: ' + (result.error || 'Upload fehlgeschlagen'));
                    }
                } catch (err) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Formular einreichen \u2192';
                    alert('Upload fehlgeschlagen: ' + err.message);
                }
            });
            uploadDiv.appendChild(submitBtn);

            el.appendChild(uploadDiv);
        }

        // Primary action buttons
        if (c.actions && c.actions.length > 0) {
            var actionsDiv = document.createElement('div');
            actionsDiv.className = 'vtx-info-card__actions';
            actionsDiv.style.cssText = 'flex-wrap:wrap;gap:4px;padding:8px 12px;border-top:1px solid #f3f4f6';
            c.actions.forEach(function(action) {
                var btn = document.createElement('button');
                btn.className = 'vtx-choice-btn';
                btn.textContent = action;
                btn.addEventListener('click', function() {
                    self._addMessage('user', action);
                    if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                        self.ws.send(JSON.stringify({ type: 'message', content: action }));
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
            metaDiv.style.cssText = 'border-top:1px solid #f3f4f6;padding-top:8px';
            c.meta_actions.forEach(function(action) {
                var btn = document.createElement('button');
                btn.className = 'vtx-choice-btn vtx-choice-btn--secondary';
                btn.textContent = action;
                btn.addEventListener('click', function() {
                    if (action.toLowerCase().indexOf('another order') !== -1 || action.toLowerCase().indexOf('different order') !== -1) {
                        el.remove();
                        if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                            self.ws.send(JSON.stringify({ type: 'message', content: 'I want to look up a different order' }));
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
                        }
                    } else if (action.toLowerCase().indexOf('contact support') !== -1) {
                        if (self.config.contactFormUrl) {
                            window.open(self.config.contactFormUrl, '_blank');
                        } else {
                            self._addMessage('user', 'I need to speak with support');
                            if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                                self.ws.send(JSON.stringify({ type: 'message', content: 'I need to speak with support' }));
                            }
                        }
                    } else {
                        self._addMessage('user', action);
                        if (self.ws && self.ws.readyState === WebSocket.OPEN) {
                            self.ws.send(JSON.stringify({ type: 'message', content: action }));
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
            const parts = str.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\(https?:\/\/[^)\n]+\))/g);
            parts.forEach((part) => {
                if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
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
                            copyBtn.setAttribute('aria-label', 'Copy tracking number');
                            copyBtn.setAttribute('title', 'Copy');
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
