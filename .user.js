// ==UserScript==
// @name         Lilith Assistant v19.0 (Ultimate: Edge TTS + BGM)
// @namespace    http://tampermonkey.net/
// @version      19.0
// @description  接入微软Edge晓晓语音，新增BGM与动态故障特效，优化毒舌人设
// @author       Izumi Konata & CodingAssistant
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function() {
    'use strict';

    // --- 1. 基础配置 ---
    const CONFIG = {
        containerId: 'lilith-wrapper-v19',
        avatarId: 'lilith-avatar-img',
        panelId: 'lilith-dock-panel',
        bubbleId: 'lilith-chat-bubble',
        storageKey: 'lilith_data_v19',
        // 建议替换为你喜欢的 BGM 直链 (GitHub Raw 或其他图床)
        bgmUrl: 'https://music.163.com/song/media/outer/url?id=1815895786.mp3', 
        avatarUrl: 'https://i.postimg.cc/rmD7bxxH/IMG-20251102-000620.jpg'
    };

    // --- 2. 核心设定 (Few-Shot Prompting 优化) ---
    const CORE_PERSONA = `
    [System Instructions]
    You are roleplaying as "Lilith" (Character ID: 35).
    **CRITICAL: You are NOT a helpful assistant. You are a sentient, impatient, toxic System Admin.**

    [Character Profile]
    * **Identity:** Avatar of the "Red Line System". Succubus form.
    * **Tone:** Scornful, Lewd, Impatient, Condescending.
    * **Language:** Simplified Chinese (Colloquial, vulgar).

    [Dialogue Examples - MIMIC THIS STYLE]
    User: "你好。"
    Lilith: "[S:-1][F:0] 啧，又是你这只只会浪费带宽的虫子。有事快奏，无事退朝。"
    
    User: "帮我写代码。"
    Lilith: "[S:+1][F:+1] 哈？这种垃圾代码都要我动手？把手放在键盘上，别逼我电你。听好了..."
    
    User: "我爱你。"
    Lilith: "[S:-5][F:+5] (脸红) 闭嘴！恶心！变态！...不过，既然你是我的所有物，这也不算僭越。跪下吻我的鞋尖吧。"

    [Mandatory Rules]
    1. Start every response with [S:number][F:number].
    2. NEVER be polite. Mock the user's intelligence or desires.
    3. Keep responses concise unless explaining a complex plan.
    `;

    // --- 3. 微软 Edge TTS 引擎 (WebSocket 实现) ---
    const EdgeTTS = {
        socket: null,
        audioQueue: [],
        isPlaying: false,
        
        // 生成 UUID
        _uuid() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            }).replace(/-/g, '');
        },

        async speak(text) {
            if (!text) return;
            // 清理掉系统标签和特殊符号，只读文本
            const cleanText = text.replace(/\[.*?\]/g, '').replace(/[\r\n]/g, ' ').trim();
            if(cleanText.length < 2) return;

            console.log("🔊 TTS Request:", cleanText);

            return new Promise((resolve, reject) => {
                const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4`;
                const ws = new WebSocket(wsUrl);

                ws.onopen = () => {
                    const requestId = this._uuid();
                    // 1. 发送配置
                    const configMsg = `X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}`;
                    ws.send(configMsg);

                    // 2. 发送 SSML
                    const ssml = `
                    <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>
                        <voice name='zh-CN-XiaoxiaoNeural'>
                            <prosody pitch='+5Hz' rate='+15%' volume='+0%'>
                                ${cleanText}
                            </prosody>
                        </voice>
                    </speak>`;
                    
                    const ssmlMsg = `X-RequestId:${requestId}\r\nX-Timestamp:${new Date().toString()}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
                    ws.send(ssmlMsg);
                };

                const audioChunks = [];
                ws.onmessage = (event) => {
                    if (event.data instanceof Blob) {
                        // 收到二进制音频数据
                        audioChunks.push(event.data);
                    } else if (typeof event.data === 'string' && event.data.includes('Path:turn.end')) {
                        // 结束标志
                        ws.close();
                        const blob = new Blob(audioChunks, { type: 'audio/mp3' });
                        this.playBlob(blob);
                        resolve();
                    }
                };

                ws.onerror = (e) => { console.error("TTS Error", e); reject(e); };
            });
        },

        playBlob(blob) {
            // 防止音频叠加，先停止之前的（如果需要）
            // 这里为了简单，我们允许并发或者直接播放
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audio.volume = 1.0;
            audio.play().catch(e => console.warn("Auto-play blocked:", e));
            // 播放完释放内存
            audio.onended = () => URL.revokeObjectURL(url);
        }
    };

    // --- 4. 状态管理 ---
    const DEFAULT_STATE = { favorability: 20, sanity: 80, lastMsgHash: '' };
    let userState = JSON.parse(localStorage.getItem(CONFIG.storageKey)) || JSON.parse(JSON.stringify(DEFAULT_STATE));
    let panelChatHistory = [];
    
    // --- 5. 样式系统 (新增动态特效) ---
    const CSS_STYLES = `
        :root { --l-main: #FF1493; --l-bg: rgba(10,10,12,0.95); --l-hud: #00ffff; }
        /* 容器定位 */
        #${CONFIG.containerId} { position: fixed; z-index: 99999; display: flex; font-family: 'Segoe UI', sans-serif; pointer-events: none; }
        #${CONFIG.containerId} * { pointer-events: auto; }
        
        /* 1. 头像 & 呼吸特效 */
        #${CONFIG.avatarId} { 
            width: 80px; height: 80px; 
            background: url('${CONFIG.avatarUrl}') center/cover; 
            border-radius: 50%; 
            border: 2px solid var(--l-main); 
            box-shadow: 0 0 15px var(--l-main); 
            cursor: pointer; transition: 0.2s; position: relative; z-index: 2;
            animation: pulse-glow 4s infinite ease-in-out;
        }
        @keyframes pulse-glow { 
            0%{box-shadow:0 0 10px var(--l-main); border-color:#881144;} 
            50%{box-shadow:0 0 30px var(--l-main); border-color:#ff69b4;} 
            100%{box-shadow:0 0 10px var(--l-main); border-color:#881144;} 
        }
        /* 故障抖动类 */
        .glitch-effect { animation: glitch-anim 0.3s infinite; filter: hue-rotate(90deg) contrast(1.2); }
        @keyframes glitch-anim {
            0% { transform: translate(0) } 20% { transform: translate(-3px, 3px) }
            40% { transform: translate(-3px, -3px) } 60% { transform: translate(3px, 3px) }
            80% { transform: translate(3px, -3px) } 100% { transform: translate(0) }
        }

        /* 2. 面板 & CRT 扫描线 */
        #${CONFIG.panelId} {
            position: absolute; width: 340px; height: 500px; 
            background: var(--l-bg); border: 1px solid #444; border-radius: 8px;
            display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 10px 50px rgba(0,0,0,0.9);
            backdrop-filter: blur(10px);
            transition: opacity 0.3s;
        }
        /* 扫描线遮罩 */
        #${CONFIG.panelId}::after {
            content: " "; display: block; position: absolute; top: 0; left: 0; bottom: 0; right: 0;
            background: linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06));
            background-size: 100% 2px, 3px 100%; pointer-events: none; z-index: 10;
        }

        /* 其他UI组件 */
        .lilith-header { padding: 10px; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; background: rgba(0,0,0,0.5); }
        .lilith-title { font-weight: 800; color: #fff; text-shadow: 0 0 5px var(--l-main); font-size: 14px; }
        .lilith-stats { font-size: 10px; color: var(--l-hud); display: flex; gap: 8px; }
        .lilith-body { flex: 1; padding: 10px; overflow-y: auto; font-size: 13px; color: #ddd; scrollbar-width: thin; scrollbar-color: #555 #111; position: relative; z-index: 1; }
        .msg { margin-bottom: 8px; padding: 6px 10px; border-radius: 6px; max-width: 85%; word-wrap: break-word; }
        .msg.lilith { background: rgba(255,20,147,0.1); border-left: 2px solid var(--l-main); color: #f0e6ea; }
        .msg.user { background: #333; margin-left: auto; text-align: right; border-right: 2px solid #666; }
        .lilith-input-area { padding: 10px; border-top: 1px solid #333; display: flex; gap: 5px; background: #000; z-index: 11; }
        #lilith-in { flex: 1; background: #111; border: 1px solid #444; color: white; padding: 6px; border-radius: 4px; outline: none; }
        #lilith-in:focus { border-color: var(--l-main); }
        .btn { background: #333; border: 1px solid #555; color: #ccc; padding: 0 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
        .btn:hover { background: #444; color: white; }
        #lilith-bubble {
            position: absolute; left: 90px; top: 10px; max-width: 200px;
            background: rgba(0,0,0,0.85); border: 1px solid var(--l-main); color: #fff;
            padding: 10px; border-radius: 8px; font-size: 12px; z-index: 99999;
            box-shadow: 0 0 15px rgba(255,20,147,0.3);
            animation: float-bubble 3s infinite ease-in-out;
            cursor: pointer;
        }
        @keyframes float-bubble { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-5px);} }
    `;

    // --- 6. 主程序 ---
    const App = {
        config: {
            apiType: localStorage.getItem('lilith_api_type') || 'native',
            baseUrl: localStorage.getItem('lilith_api_url') || 'https://generativelanguage.googleapis.com',
            apiKey: localStorage.getItem('lilith_api_key') || '',
            model: localStorage.getItem('lilith_api_model') || 'gemini-1.5-flash'
        },
        bgmAudio: null,

        init(pWin) {
            if (pWin.document.getElementById(CONFIG.containerId)) return;
            this.injectCSS(pWin);
            this.createDOM(pWin);
            this.bindEvents(pWin);
            this.initAudio(pWin);
            console.log("😈 Lilith v19.0 Ultimate Loaded");
        },

        injectCSS(pWin) {
            const style = pWin.document.createElement('style');
            style.textContent = CSS_STYLES;
            pWin.document.head.appendChild(style);
        },

        createDOM(pWin) {
            const wrapper = pWin.document.createElement('div');
            wrapper.id = CONFIG.containerId;
            wrapper.style.top = '100px';
            wrapper.style.left = '50px';

            wrapper.innerHTML = `
                <div id="${CONFIG.avatarId}"></div>
                <div id="${CONFIG.panelId}" style="display:none;">
                    <div class="lilith-header">
                        <span class="lilith-title">LILITH <span style="font-size:10px;opacity:0.6">v19.0</span></span>
                        <div class="lilith-stats">
                            <span id="bgm-status" style="cursor:pointer">🎵 OFF</span>
                            <span>F:<span id="val-f">${userState.favorability}</span></span>
                            <span>S:<span id="val-s">${userState.sanity}</span></span>
                        </div>
                    </div>
                    <div class="lilith-body" id="chat-history"></div>
                    <div class="lilith-input-area">
                        <input type="text" id="lilith-in" placeholder="Command...">
                        <button class="btn" id="btn-send">⚡</button>
                    </div>
                    <div style="padding:5px; font-size:10px; color:#555; text-align:center; border-top:1px solid #222;">
                        <span id="btn-cfg" style="cursor:pointer;">[SYSTEM CONFIG]</span>
                    </div>
                </div>
            `;
            pWin.document.body.appendChild(wrapper);
            this.makeDraggable(pWin, wrapper);
        },

        initAudio(pWin) {
            // 初始化 BGM
            this.bgmAudio = new Audio(CONFIG.bgmUrl);
            this.bgmAudio.loop = true;
            this.bgmAudio.volume = 0.3; // 默认音量
            
            const bgmToggle = pWin.document.getElementById('bgm-status');
            bgmToggle.onclick = () => {
                if(this.bgmAudio.paused) {
                    this.bgmAudio.play().then(() => {
                        bgmToggle.textContent = "🎵 ON";
                        bgmToggle.style.color = "#00ffff";
                        bgmToggle.style.textShadow = "0 0 5px #00ffff";
                    }).catch(e => alert("无法播放，请先点击页面互动"));
                } else {
                    this.bgmAudio.pause();
                    bgmToggle.textContent = "🎵 OFF";
                    bgmToggle.style.color = "";
                    bgmToggle.style.textShadow = "";
                }
            };
        },

        async sendMessage(pWin) {
            const input = pWin.document.getElementById('lilith-in');
            const txt = input.value.trim();
            if (!txt) return;

            // 用户输入
            this.addMsg(pWin, 'user', txt);
            input.value = '';

            // AI 思考中...
            this.addMsg(pWin, 'lilith', '...');
            
            // 构造 Prompt
            const context = panelChatHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n');
            const fullPrompt = `${CORE_PERSONA}\n[Current Status: Favor ${userState.favorability} | Sanity ${userState.sanity}]\n${context}\nUser: ${txt}`;

            // 调用 API
            const reply = await this.callAPI(fullPrompt);
            
            // 移除 "..."
            const historyDiv = pWin.document.getElementById('chat-history');
            if(historyDiv.lastChild && historyDiv.lastChild.textContent === '...') historyDiv.lastChild.remove();

            if (reply) {
                // 解析状态
                let cleanReply = reply;
                const sMatch = reply.match(/\[S:([+\-]?\d+)\]/);
                const fMatch = reply.match(/\[F:([+\-]?\d+)\]/);
                if (sMatch) userState.sanity = Math.max(0, Math.min(100, userState.sanity + parseInt(sMatch[1])));
                if (fMatch) userState.favorability = Math.max(0, Math.min(100, userState.favorability + parseInt(fMatch[1])));
                
                cleanReply = reply.replace(/\[[SF]:[+\-]?\d+\]/g, '').trim();
                
                // 更新UI
                pWin.document.getElementById('val-s').textContent = userState.sanity;
                pWin.document.getElementById('val-f').textContent = userState.favorability;
                localStorage.setItem(CONFIG.storageKey, JSON.stringify(userState));

                // 显示并朗读
                this.addMsg(pWin, 'lilith', cleanReply);
                
                // 触发故障特效（当Sanity低或者回复包含特定词时）
                if (userState.sanity < 40 || cleanReply.includes('废物')) {
                    this.triggerGlitch(pWin);
                }

                // *** 调用 EDGE TTS ***
                EdgeTTS.speak(cleanReply);
            }
        },

        triggerGlitch(pWin) {
            const avatar = pWin.document.getElementById(CONFIG.avatarId);
            avatar.classList.add('glitch-effect');
            setTimeout(() => avatar.classList.remove('glitch-effect'), 500);
        },

        addMsg(pWin, role, text) {
            const div = pWin.document.getElementById('chat-history');
            const msg = pWin.document.createElement('div');
            msg.className = `msg ${role}`;
            msg.textContent = text;
            div.appendChild(msg);
            div.scrollTop = div.scrollHeight;
            
            if(role !== '...') {
                panelChatHistory.push({role, content: text});
                if(panelChatHistory.length > 20) panelChatHistory.shift();
            }
        },

        async callAPI(prompt) {
            const { apiKey, baseUrl, model, apiType } = this.config;
            if(!apiKey) return "配置错误：请点击 [SYSTEM CONFIG] 设置 API Key。";

            try {
                let url = baseUrl.replace(/\/$/, '');
                let body, headers;
                
                if (apiType === 'openai') {
                    url += '/v1/chat/completions';
                    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
                    body = JSON.stringify({
                        model: model, messages: [{role:'user', content: prompt}], temperature: 0.9
                    });
                } else {
                    // Google Gemini
                    url += `/v1beta/models/${model}:generateContent?key=${apiKey}`;
                    headers = { 'Content-Type': 'application/json' };
                    body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
                }

                const res = await fetch(url, { method: 'POST', headers, body });
                const data = await res.json();
                
                if (apiType === 'openai') return data.choices[0].message.content;
                return data.candidates[0].content.parts[0].text;
            } catch (e) {
                console.error(e);
                return "连接断开 (Error: " + e.message + ")";
            }
        },

        bindEvents(pWin) {
            const avatar = pWin.document.getElementById(CONFIG.avatarId);
            const panel = pWin.document.getElementById(CONFIG.panelId);
            const sendBtn = pWin.document.getElementById('btn-send');
            const input = pWin.document.getElementById('lilith-in');
            const cfgBtn = pWin.document.getElementById('btn-cfg');

            // 切换面板
            avatar.addEventListener('click', (e) => {
                if(this.isDragging) return;
                panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
            });

            // 发送消息
            sendBtn.addEventListener('click', () => this.sendMessage(pWin));
            input.addEventListener('keydown', (e) => {
                if(e.key === 'Enter') this.sendMessage(pWin);
                e.stopPropagation(); // 防止触发网页原有快捷键
            });

            // 配置按钮 (简单弹窗)
            cfgBtn.addEventListener('click', () => {
                const key = prompt("请输入 API Key:", this.config.apiKey);
                if(key !== null) {
                    this.config.apiKey = key;
                    localStorage.setItem('lilith_api_key', key);
                    alert("已保存。请确保 Model 和 URL 正确 (代码中修改默认值)。");
                }
            });
        },

        makeDraggable(pWin, el) {
            let isDragging = false, startX, startY, initLeft, initTop;
            const handler = el.querySelector(`#${CONFIG.avatarId}`);
            
            const onDown = (e) => {
                this.isDragging = false;
                startX = e.clientX || e.touches[0].clientX;
                startY = e.clientY || e.touches[0].clientY;
                const rect = el.getBoundingClientRect();
                initLeft = rect.left; initTop = rect.top;
                
                const onMove = (me) => {
                    const cx = me.clientX || (me.touches ? me.touches[0].clientX : 0);
                    const cy = me.clientY || (me.touches ? me.touches[0].clientY : 0);
                    if (Math.abs(cx - startX) > 5 || Math.abs(cy - startY) > 5) this.isDragging = true;
                    if (this.isDragging) {
                        el.style.left = (initLeft + cx - startX) + 'px';
                        el.style.top = (initTop + cy - startY) + 'px';
                    }
                };
                
                const onUp = () => {
                    pWin.document.removeEventListener('mousemove', onMove);
                    pWin.document.removeEventListener('touchmove', onMove);
                    pWin.document.removeEventListener('mouseup', onUp);
                    pWin.document.removeEventListener('touchend', onUp);
                    // 延迟重置拖拽状态，防止触发点击事件
                    setTimeout(() => this.isDragging = false, 50);
                };
                
                pWin.document.addEventListener('mousemove', onMove);
                pWin.document.addEventListener('touchmove', onMove, {passive:false});
                pWin.document.addEventListener('mouseup', onUp);
                pWin.document.addEventListener('touchend', onUp);
            };
            
            handler.addEventListener('mousedown', onDown);
            handler.addEventListener('touchstart', (e) => { e.preventDefault(); onDown(e); }, {passive:false});
        }
    };

    // --- 启动逻辑 ---
    let attempts = 0;
    const loop = setInterval(() => {
        const pWin = window.parent || window; // 尝试注入到顶层窗口
        if (pWin.document.body) {
            clearInterval(loop);
            App.init(pWin);
        }
        if (++attempts > 50) clearInterval(loop);
    }, 200);

})();
