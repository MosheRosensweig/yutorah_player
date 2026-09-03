/* =========================================================
   VTT → Accordion Chapters + Sentences (FULL FILE)
   Binds to the vidstack <media-player> element rather than a
   raw <audio>, so it works for hosted audio, hosted video and
   the YouTube provider (which has no media element to observe).
   ========================================================= */

/* ---------- Utilities ---------- */

function toSeconds(time) {
    const p = time.split(':').map(Number);
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    throw new Error('Invalid VTT timestamp: ' + time);
}

function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

function formatChapterDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds >= 60) {
        const mins = Math.round(seconds / 60);
        return `${mins} ${mins === 1 ? 'min' : 'mins'}`;
    }
    return `${seconds} sec`;
}

function parseVTT(text) {
    const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim());
    const cues = [];
    let i = 0;

    while (i < lines.length) {
        if (!lines[i] || lines[i] === 'WEBVTT') {
            i++;
            continue;
        }

        if (lines[i].includes('-->')) {
            const [s, e] = lines[i].split('-->').map(v => v.trim());
            const start = toSeconds(s);
            const end = toSeconds(e);
            i++;

            const txt = [];
            while (i < lines.length && lines[i] && !lines[i].includes('-->')) {
                txt.push(lines[i]);
                i++;
            }

            cues.push({ start, end, text: txt.join(' ') });
            continue;
        }

        i++;
    }

    return cues;
}

async function loadVTT(url) {
    if (!url) return [];
    try {
        const r = await fetch(url);
        if (!r.ok) return [];
        return parseVTT(await r.text());
    } catch {
        return [];
    }
}

/* ---------- Media adapter ----------
   Normalises a vidstack <media-player> and a plain <audio>/<video>
   behind one interface. The YouTube provider only reports progress
   through the player element, never through a media element.
------------------------------------ */

class MediaAdapter {
    constructor(el) {
        this.el = el;
        this.isPlayer = el.tagName.toLowerCase() === 'media-player';
    }

    get currentTime() {
        return this.isPlayer
            ? (this.el.state?.currentTime ?? this.el.currentTime ?? 0)
            : this.el.currentTime;
    }

    seek(time) {
        try {
            this.el.currentTime = time;
        } catch {
            /* provider not ready yet */
        }
    }

    play() {
        const p = this.el.play?.();
        if (p && typeof p.catch === 'function') p.catch(() => { });
    }

    onTimeUpdate(cb) {
        if (this.isPlayer) {
            // vidstack dispatches time-update for every provider, YouTube included
            this.el.addEventListener('time-update', e => {
                cb(e.detail?.currentTime ?? this.currentTime);
            });
        } else {
            this.el.addEventListener('timeupdate', () => cb(this.el.currentTime));
        }
    }
}

/* Prefer the audio player; fall back to the video player, which is the
   only one present for YouTube-hosted shiurim. */
function resolveMediaSource() {
    const player =
        document.querySelector('media-player[view-type="audio"]') ||
        document.querySelector('media-player.player-video') ||
        document.querySelector('media-player');

    if (player) {
        return {
            media: new MediaAdapter(player),
            chaptersUrl: player.querySelector('track[kind="chapters"]')?.src ?? null,
            sentencesUrl: player.querySelector('track[kind="metadata"]')?.src ?? null
        };
    }

    const el = document.querySelector('audio, video');
    if (!el) return null;

    return {
        media: new MediaAdapter(el),
        chaptersUrl: document.querySelector('track[kind="chapters"]')?.src ?? null,
        sentencesUrl: document.querySelector('track[kind="metadata"]')?.src ?? null
    };
}

/* ---------- Core ---------- */

class TranscriptAccordion {
    constructor({ media, chaptersVttUrl, sentencesVttUrl, container }) {
        this.media = media;
        this.container = container;

        this.currentChapterIndex = -1;
        this.currentSentenceIndex = -1;

        this.autoScrollEnabled = true;
        this.userScrollTimeout = null;
        this.USER_SCROLL_IDLE_MS = 1500;

        this.ready = Promise.all([
            loadVTT(chaptersVttUrl),
            loadVTT(sentencesVttUrl)
        ]).then(([chapters, sentences]) => {
            this.sentences = sentences;

            if (sentences.length === 0) {
                this.chapters = [];
                this.sentenceNodes = [];
                this.container.classList.add('is-empty');
                return;
            }

            if (chapters.length === 0) {
                // Synthesise a single "Content" chapter spanning all sentences
                this.chapters = [{
                    index: 0,
                    start: sentences[0].start,
                    end: sentences[sentences.length - 1].end,
                    text: 'Content',
                    sentences: []
                }];
            } else {
                this.chapters = chapters.map((c, i) => ({
                    ...c,
                    index: i,
                    sentences: []
                }));
            }

            this.assign();
            this.render();
            this.bindUserScrollDetection();
            this.bindMedia();
        });
    }

    /* ---------- Assignment ---------- */

    assign() {
        let ci = 0;
        for (const s of this.sentences) {
            while (
                ci < this.chapters.length - 1 &&
                s.start >= this.chapters[ci].end
            ) {
                ci++;
            }
            s.chapterIndex = ci;
            this.chapters[ci].sentences.push(s);
        }
    }

    /* ---------- Render ---------- */

    render() {
        this.container.innerHTML = '';
        this.sentenceNodes = [];

        this.chapters.forEach(ch => {
            const wrapper = document.createElement('div');
            wrapper.className = 'ac';

            const header = document.createElement('h2');
            header.className = 'ac-header';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ac-trigger';
            btn.innerHTML = `
                <span class="ac-time">${formatTime(ch.start)}</span>
                <span class="ac-chapter">${ch.text}</span>
                <span class="ac-duration">${formatChapterDuration(ch.end - ch.start)}</span>
            `;

            header.appendChild(btn);

            const panel = document.createElement('div');
            panel.className = 'ac-panel';

            const panel_fixed = document.createElement('div');
            panel_fixed.className = 'ac-panel-fixed';

            const panel_wrapper = document.createElement('div');
            panel_wrapper.className = 'ac-panel-wrapper';

            ch.sentences.forEach(s => {
                const el = document.createElement('div');
                el.className = 'sentence';
                el.innerHTML = `<span class="ac-time">${formatTime(s.start)}</span><p>${s.text}</p>`;

                el.addEventListener('click', () => {
                    this.media.seek(s.start);
                    this.media.play();
                });

                this.sentenceNodes.push({
                    s,
                    el,
                    panel: panel_fixed
                });

                panel_wrapper.appendChild(el);
            });

            panel_fixed.appendChild(panel_wrapper);
            panel.appendChild(panel_fixed);
            wrapper.appendChild(header);
            wrapper.appendChild(panel);
            this.container.appendChild(wrapper);
        });
    }

    /* ---------- Scroll Detection ---------- */

    bindUserScrollDetection() {
        this.container.querySelectorAll('.ac-panel-fixed').forEach(panel => {
            const onScroll = () => this.onUserScroll();
            panel.addEventListener('wheel', onScroll, { passive: true });
            panel.addEventListener('touchmove', onScroll, { passive: true });
            panel.addEventListener('scroll', onScroll, { passive: true });
        });
    }

    onUserScroll() {
        this.autoScrollEnabled = false;
        clearTimeout(this.userScrollTimeout);
        this.userScrollTimeout = setTimeout(() => {
            this.autoScrollEnabled = true;
        }, this.USER_SCROLL_IDLE_MS);
    }

    /* ---------- Lookup ---------- */

    findSentenceIndex(t) {
        const arr = this.sentenceNodes;
        let l = 0;
        let r = arr.length - 1;

        while (l <= r) {
            const m = (l + r) >> 1;
            if (t < arr[m].s.start) r = m - 1;
            else if (t >= arr[m].s.end) l = m + 1;
            else return m;
        }

        return -1;
    }

    /* ---------- Media Sync ---------- */

    bindMedia() {
        this.media.onTimeUpdate(t => {
            if (typeof t !== 'number' || Number.isNaN(t)) return;

            const si = this.findSentenceIndex(t);
            if (si !== this.currentSentenceIndex) {
                if (this.currentSentenceIndex !== -1) {
                    this.sentenceNodes[this.currentSentenceIndex].el.classList.remove('active');
                }
                if (si !== -1) {
                    this.sentenceNodes[si].el.classList.add('active');
                }
                this.currentSentenceIndex = si;
            }

            if (si === -1) return;

            const node = this.sentenceNodes[si];
            const chIndex = node.s.chapterIndex;

            if (chIndex !== this.currentChapterIndex) {
                this.currentChapterIndex = chIndex;
                if (window.acc?.open) {
                    const accordionElements = document.querySelectorAll('.ac-transcript .ac');

                    [...accordionElements].forEach((element, idx) => {
                        if (element.classList.contains('is-active')) {
                            window.acc.close(idx);
                        }
                    });
                    window.acc.open(chIndex);
                }
            }

            if (!this.autoScrollEnabled) return;

            const activeSentenceEl = node.el;
            const panelFixed = node.panel;
            if (!panelFixed) return;

            const panelRect = panelFixed.getBoundingClientRect();
            const sentenceRect = activeSentenceEl.getBoundingClientRect();

            const sentenceTopInPanel =
                sentenceRect.top - panelRect.top + panelFixed.scrollTop;

            const sentenceCenter =
                sentenceTopInPanel -
                panelFixed.clientHeight / 2 +
                activeSentenceEl.offsetHeight / 2;

            if (Math.abs(panelFixed.scrollTop - sentenceCenter) > 4) {
                animateScrollTop(panelFixed, sentenceCenter, 280);
            }
        });
    }
}

/* ---------- Init ---------- */

document.addEventListener('DOMContentLoaded', async () => {
    if (window.innerWidth < 1024) {
        moveElement('.new-sidebar__content .new-sidebar--transcription', '.mobile-modal-transcription > div', 'prepend');
    }

    const container = document.querySelector('.ac-transcript');
    if (!container) return;

    // Wait for the custom element to upgrade so state/events are available.
    if (window.customElements?.whenDefined) {
        try {
            await customElements.whenDefined('media-player');
        } catch { /* vidstack not on the page */ }
    }

    const source = resolveMediaSource();
    if (!source || !source.sentencesUrl) {
        container.classList.add('is-empty');
        return;
    }

    const transcript = new TranscriptAccordion({
        media: source.media,
        chaptersVttUrl: source.chaptersUrl,
        sentencesVttUrl: source.sentencesUrl,
        container
    });

    transcript.ready.then(() => {
        if (transcript.chapters.length > 0) {
            window.acc = new Accordion('.ac-transcript');
        }
    });
});


function moveElement(element, newParent, position) {
    const el = typeof element === 'string'
        ? document.querySelector(element)
        : element;

    const parent = typeof newParent === 'string'
        ? document.querySelector(newParent)
        : newParent;

    if (!el || !parent) return;

    switch (position) {
        case 'prepend':
            parent.prepend(el);
            break;
        case 'before':
            parent.before(el);
            break;
        case 'after':
            parent.after(el);
            break;
        default:
            parent.appendChild(el);
    }
}


/* ---------- Smooth Scroll ---------- */

function animateScrollTop(el, to, duration = 300) {
    const start = el.scrollTop;
    const change = to - start;
    const startTime = performance.now();

    function easeInOut(t) {
        return t < 0.5
            ? 2 * t * t
            : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    function animate(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        el.scrollTop = start + change * easeInOut(progress);
        if (progress < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
}