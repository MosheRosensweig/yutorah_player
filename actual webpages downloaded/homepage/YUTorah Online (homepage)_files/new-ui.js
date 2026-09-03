import 'https://cdn.vidstack.io/player';

let _queueLoadInFlight = false;
let _queueLoadDone = false;

document.addEventListener("DOMContentLoaded", async function () {
    initPlayer();
    initAccordions();
    initTabs();
    initMenus();
    initThreads();
    initBannerRotation();
    initFloatingSidebar();
    initPopups();
    initMobileModals();
    initQueueLoad();
    initSidebarSearch();
    initShiurRemove();
    initThumbnailClicks();

    window.addEventListener("resize", () => {
        initEllipsis();
    });

    if (window.innerWidth <= 1023) {
        moveElement('.new-sidebar', '.new-banner', 'before')
        moveElement('.new-sidebar__content .new-sidebar--summary', '.mobile-modal-summary .mobile-modal__content > div')
        moveElement('.new-sidebar__content .new-sidebar--quiz', '.mobile-modal-quiz .mobile-modal__content > div')

        moveElement('.shiur-wrapper .ac-panel-wrapper', '.tabs--shiur')
        moveElement('.new-banner', '.tabs--learning');
        moveElement('.new-comments', '.tabs--playing');

        document.querySelectorAll('.new-collection__played').forEach(el => {
            moveElement(el, el.closest('.new-collection__side').querySelector('.new-collection__title'));
        });


    }
    initSpeedControls();
})

function initPlayer() {
    const playerWrapper = document.querySelector('.player__wrapper');
    const openPlayerButton = document.querySelector('#open-player');
    if (openPlayerButton) {
        openPlayerButton.addEventListener('click', function () {
            playerWrapper.classList.remove('active-buttons')
            playerWrapper.classList.add('active-audio')
        })
    }
    const openVideoButton = document.querySelector('#open-video');
    if (openVideoButton) {
        openVideoButton.addEventListener('click', function () {
            playerWrapper.classList.remove('active-buttons')
            playerWrapper.classList.add('active-video')
        })
    }

    if (mediaType == "video" && !bothMedia) {
        playerWrapper.classList.remove('active-buttons')
        playerWrapper.classList.add('active-video')
    }
    else if (mediaType == "audio") {
        playerWrapper.classList.remove('active-buttons')
        playerWrapper.classList.add('active-audio')
    }

    initMediaSwitch(playerWrapper);
}

// In-player toggle for shiurim that have both an audio and a video view.
// Buttons live inside each player's own control bar (and, for YouTube video,
// as an overlay on the iframe since it has no reachable controls of its own).
// Switching carries the current playback position (and play/pause state) over
// to the destination player so listening/watching picks up where it left off.
function initMediaSwitch(playerWrapper) {
    const switchButtons = document.querySelectorAll('.player-switch-button');
    if (!switchButtons.length) return;

    const videoPlayerEl = document.querySelector('.player__video-wrapper media-player');
    const audioPlayerEl = document.querySelector('.player__audio-wrapper media-player');
    const youtubeIframe = document.querySelector('.player-video--youtube iframe');

    switchButtons.forEach(function (button) {
        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            switchMedia(button.dataset.switchTarget);
        });
    });

    // A plain YouTube iframe exposes no media API, so the only reliable way to stop
    // it is to reload the embed without autoplay.
    function stopYouTube() {
        if (!youtubeIframe) return;
        const url = new URL(youtubeIframe.src);
        url.searchParams.delete('autoplay');
        youtubeIframe.src = url.toString();
    }

    function switchMedia(target) {
        const switchingToVideo = target === 'video';
        const sourceEl = switchingToVideo ? audioPlayerEl : videoPlayerEl;

        let currentTime = null;
        let wasPlaying = false;

        // Always stop whatever is playing before the destination player starts,
        // otherwise the two sources overlap.
        if (sourceEl) {
            currentTime = sourceEl.currentTime;
            wasPlaying = !sourceEl.paused;
            sourceEl.pause();
        } else if (!switchingToVideo) {
            // Leaving a YouTube video: its position can't be read, but it must not
            // keep playing behind the audio player.
            stopYouTube();
        }

        playerWrapper.classList.remove('active-audio', 'active-video', 'active-buttons');
        playerWrapper.classList.add(switchingToVideo ? 'active-video' : 'active-audio');

        const destinationEl = switchingToVideo ? videoPlayerEl : audioPlayerEl;
        if (destinationEl && currentTime != null) {
            destinationEl.currentTime = currentTime;
            if (wasPlaying) destinationEl.play().catch(() => { });
        } else if (switchingToVideo && !videoPlayerEl && youtubeIframe && currentTime != null) {
            // YouTube embeds have no reachable media API from a plain iframe, so the
            // best we can do is reload it seeked to the same start time via the URL.
            const url = new URL(youtubeIframe.src);
            url.searchParams.set('start', Math.floor(currentTime));
            if (wasPlaying) url.searchParams.set('autoplay', '1');
            youtubeIframe.src = url.toString();
        }
    }
}

function initAccordions() {
    if (document.querySelector(".ac-description")) {
        new Accordion(".ac-description");
    }
    new Accordion(".ac-summary", {
        showMultiple: true,
    });
    let quizAc = new Accordion(".ac-quiz", {
        showMultiple: true,
    });
    quizAc.openAll();

    document.querySelectorAll(".new-floating-sidebar .accordion-container").forEach(function (el) {
        let sidebarAc = new Accordion(el, {
            showMultiple: true,
        });
        sidebarAc.openAll();
    })
}

function initTabs() {
    document.querySelectorAll("[class*='tabs-buttons-']").forEach(function (el) {
        const className = [...el.classList].find(c => c.startsWith("tabs-buttons-"));
        const suffix = className.split("tabs-buttons-")[1];
        const buttons = el.querySelectorAll('button');
        const contents = document.querySelectorAll('.tabs-content-' + suffix + ' > *');
        setupTabs(buttons, contents);
    })

    setupTabs(
        document.querySelectorAll(".new-floating-sidebar__content .new-tags button"),
        document.querySelectorAll('.new-floating-sidebar .accordion-container'),
        document.querySelectorAll(".new-floating-sidebar__preview .new-tags button"),
        document.querySelectorAll(".new-floating-sidebar__preview .new-floating-sidebar__preview-tabs .new-floating-sidebar__thumbnails-column")
    )
}

function initMenus() {
    document.querySelectorAll('.custom-menu-wrapper').forEach(function (wrapper) {
        const button = wrapper.querySelector('.custom-menu-button');
        const menu = wrapper.querySelector('.custom-menu');
        button.addEventListener('click', function () {
            menu.classList.toggle('active')
        })
    })
}

function initThreads() {
    document.querySelectorAll('.new-thread').forEach(function (thread) {
        const open = thread.querySelector('.new-thread__expand');
        const close = thread.querySelector('.new-thread__collapse');
        open.addEventListener('click', function () {
            thread.classList.add('active');
        })
        close.addEventListener('click', function () {
            thread.classList.remove('active');
        })
    })
}

function initEllipsis() {
    document.querySelectorAll('.ellipsis-js').forEach(function (el) {
        el.removeAttribute('style');
        el.classList.remove('ellipsis-js-active');
        const width = el.offsetWidth;
        el.style.width = `${width}px`;
        el.classList.add('ellipsis-js-active');
    })
}

function initBannerRotation() {
    let currentIndex = 0;
    let banners = document.querySelectorAll('.new-info-banner');

    setInterval(changeAd, 10000);

    function changeAd() {
        const current = banners[currentIndex];
        currentIndex = (currentIndex + 1) % banners.length;
        const next = banners[currentIndex];

        current.style.opacity = '0';

        setTimeout(() => {
            current.classList.remove('active');
            next.classList.add('active');
            next.style.opacity = '0';

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    next.style.opacity = '1';
                });
            });
        }, 500);
    }
}

function initFloatingSidebar() {
    const wrapper = document.querySelector('.new-floating-sidebar__wrapper');
    const placeholder = document.querySelector('.new-floating-sidebar__placeholder');
    document.querySelector('.new-floating-sidebar__header').addEventListener('click', function () {

        if (wrapper.classList.contains('active')) {
            if (wrapper.classList.contains('expanded')) {
                removeWidthOfSidebar();
            }
            wrapper.classList.remove('active');
        } else {
            if (wrapper.classList.contains('expanded')) {
                fixWidthOfSidebar();
            }
            wrapper.classList.add('active');
        }
        initEllipsis();
    })
    document.querySelector('.new-floating-sidebar__expand').addEventListener('click', function () {
        if (wrapper.classList.contains('expanded')) {
            removeWidthOfSidebar();
            wrapper.classList.remove('expanded');
        } else {
            fixWidthOfSidebar();
            wrapper.classList.add('expanded');
        }
        initEllipsis();
    })

    function fixWidthOfSidebar() {
        placeholder.style.width = `${wrapper.offsetWidth}px`;
        placeholder.classList.add('active');
    }

    function removeWidthOfSidebar() {
        placeholder.removeAttribute('style');
        placeholder.classList.remove('active');
    }

}

function initPopups() {
    document.querySelectorAll('[class*="new-popup-"]').forEach(popup => {
        const suffix = Array.from(popup.classList)
            .find(cls => cls.startsWith('new-popup-'))
            ?.replace('new-popup-', '');

        if (!suffix) return;

        const openBtn = document.querySelector(`.open-popup-${suffix}`);
        const closeBtn = document.querySelector(`.close-popup-${suffix}`);

        openBtn?.addEventListener('click', () => popup.classList.add('active'));
        closeBtn?.addEventListener('click', () => popup.classList.remove('active'));

        popup.addEventListener('click', (event) => {
            if (event.target === popup) popup.classList.remove('active');
        });
    });
}

function initSpeedControls() {
    document.querySelectorAll('.vds-speed-popup').forEach(function (popup) {
        const openPopupBtn = popup.parentElement.querySelector('.vds-button');

        openPopupBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            popup.classList.toggle('active');
        });

        document.addEventListener('click', function (e) {
            if (!popup.contains(e.target) && !openPopupBtn.contains(e.target)) {
                popup.classList.remove('active');
            }
        });

        const instance = popup.querySelector("media-speed-slider");
        const instancePlayer = popup.closest("media-player");
        const valueEl = popup.querySelector(".vds-speed-popup__speed-value");

        const plus = popup.querySelector(".vds-speed-popup__slider-plus");
        const minus = popup.querySelector(".vds-speed-popup__slider-minus");
        plus.addEventListener("click", (e) => {
            instancePlayer.playbackRate = instancePlayer.playbackRate + 0.25;
        })
        minus.addEventListener("click", (e) => {
            instancePlayer.playbackRate = instancePlayer.playbackRate - 0.25;
        })

        const buttons = popup.querySelectorAll('.vds-speed-popup__buttons > div');
        const buttonsValues = [...buttons].map(btn => Number(btn.querySelector('button').innerText));

        buttons.forEach((button, index) => {
            button.querySelector('button').addEventListener('click', (e) => {
                instancePlayer.playbackRate = buttonsValues[index];
            })
        })

        instance.subscribe(({ value }) => {
            valueEl.innerHTML = value + 'x';
            buttons.forEach((btn, index) => {
                btn.classList.toggle('active', value === buttonsValues[index]);
            })
        });
    })
}

function setupTabs(buttons, contents, syncButtons, syncTabs) {
    buttons.forEach((tab, index) => {
        tab.addEventListener("click", function () {
            [...buttons, ...(syncButtons ?? [])].forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            if (syncButtons) {
                syncButtons[index].classList.add('active');
            }
            [...contents, ...(syncTabs ?? [])].forEach(c => c.classList.remove("active"));
            contents[index].classList.add("active");
            if (syncTabs) {
                syncTabs[index].classList.add('active');
            }
            initEllipsis()
        })
    })
}

// Bottom-sheet modals (mobile only, hidden above 1023px via CSS).
// Discovery is by naming convention — any element with class "mobile-modal-{name}"
// becomes a sheet. Active modals: transcription, summary, quiz, video-player.
// Open triggers: any element with class "open-modal-{name}" opens its sheet.
// See README.md for a full description of states and drag behaviour.
function initMobileModals() {
    document.querySelectorAll('[class*="mobile-modal-"]').forEach(function (sheet) {
        const name = Array.from(sheet.classList)
            .find(cls => cls.startsWith('mobile-modal-'))
            ?.replace('mobile-modal-', '');
        if (!name) return;

        // Overlay appended to <body> so it covers the full viewport above all content.
        const overlay = document.createElement('div');
        overlay.className = 'mobile-modal__overlay mobile-modal__overlay-' + name;
        document.body.appendChild(overlay);

        // Wrap sheet internals: add handle + content wrapper if not already present
        if (!sheet.querySelector('.mobile-modal__handle')) {
            const handle = document.createElement('div');
            handle.className = 'mobile-modal__handle';

            const content = document.createElement('div');
            content.className = 'mobile-modal__content';

            // Move existing children into content wrapper
            while (sheet.firstChild) {
                content.appendChild(sheet.firstChild);
            }

            sheet.appendChild(handle);
            sheet.appendChild(content);
        }

        sheet.classList.add('mobile-modal__sheet');

        const contentEl = sheet.querySelector('.mobile-modal__content');
        const handleEl = sheet.querySelector('.mobile-modal__handle');

        // Open triggers
        document.querySelectorAll('.open-modal-' + name).forEach(function (btn) {
            btn.addEventListener('click', function () {
                openModal();
            });
        });

        // Close on overlay click
        overlay.addEventListener('click', function () {
            closeModal();
        });

        function openModal() {
            overlay.classList.add('active');
            sheet.classList.add('active');
            sheet.classList.remove('snapped-top');
        }

        function closeModal() {
            sheet.classList.remove('active', 'snapped-top');
            overlay.classList.remove('active');
        }

        function snapToTop() {
            sheet.classList.add('snapped-top');
            contentEl.style.maxHeight = '';
            contentEl.style.overflowY = 'auto';
            sheet.style.transform = '';
        }

        // Drag logic
        let startY = 0;
        let currentY = 0;
        let sheetRect = null;
        let isDragging = false;

        handleEl.addEventListener('touchstart', onDragStart, { passive: true });
        handleEl.addEventListener('mousedown', onDragStart);

        function onDragStart(e) {
            isDragging = true;
            startY = e.type === 'mousedown' ? e.clientY : e.touches[0].clientY;
            sheetRect = sheet.getBoundingClientRect();
            sheet.classList.add('dragging');

            if (e.type === 'mousedown') {
                document.addEventListener('mousemove', onDragMove);
                document.addEventListener('mouseup', onDragEnd);
            } else {
                document.addEventListener('touchmove', onDragMove, { passive: false });
                document.addEventListener('touchend', onDragEnd);
            }
        }

        function onDragMove(e) {
            if (!isDragging) return;
            if (e.cancelable) e.preventDefault();

            currentY = (e.type === 'mousemove' ? e.clientY : e.touches[0].clientY) - startY;
            const isSnapped = sheet.classList.contains('snapped-top');

            if (isSnapped) {
                // When snapped top, only allow dragging down
                if (currentY > 0) {
                    sheet.style.transform = 'translateY(' + currentY + 'px)';
                }
            } else {
                // Normal state: translate the sheet
                sheet.style.transform = 'translateY(' + currentY + 'px)';
            }
        }

        function onDragEnd() {
            isDragging = false;
            sheet.classList.remove('dragging');
            document.removeEventListener('mousemove', onDragMove);
            document.removeEventListener('mouseup', onDragEnd);
            document.removeEventListener('touchmove', onDragMove);
            document.removeEventListener('touchend', onDragEnd);

            const isSnapped = sheet.classList.contains('snapped-top');
            const threshold = 80;

            if (isSnapped) {
                if (currentY > threshold) {
                    // Dragged down from snapped — close
                    sheet.style.transform = '';
                    closeModal();
                } else {
                    // Snap back to top
                    sheet.style.transform = '';
                }
            } else {
                if (currentY < -threshold) {
                    // Dragged up — snap to top
                    sheet.style.transform = '';
                    snapToTop();
                } else if (currentY > threshold) {
                    // Dragged down — close
                    sheet.style.transform = '';
                    closeModal();
                } else {
                    // Return to default position
                    sheet.style.transform = '';
                }
            }

            currentY = 0;
        }
    });
}

// Physically moves a DOM node into a new parent.
// Called at page load on mobile to place sidebar content (summary, quiz) into
// their respective modal sheets, and to reorder sections into tab slots.
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


// ────────────────────────────────────────────────────────────────────────────
// Sidebar data load
// ────────────────────────────────────────────────────────────────────────────
//
// Two endpoints feed the floating sidebar:
//
//   /Queue/queue           -> Shiurim tab (Recently Played + Watch Later)
//                             and the "recently listened" panel of Speakers
//                             (the favorites endpoint has no playback-history
//                             equivalent, so that panel still derives from queue).
//
//   /Account/UserFavorites -> "My speakers" panel (myFavoriteTeachers),
//                             Collections tab (myFavoriteCollections),
//                             and the Speakers preview thumbnails column.
//                             POST endpoint (form-encoded body).
//
// We fetch both in parallel with Promise.allSettled so one failure doesn't
// blank the whole sidebar. Mock content shipped in the cshtml is always
// cleaned up — on success it's replaced by real data, on empty response or
// any error it's replaced by a neutral empty-state message. The hardcoded
// "Rabbi Hershel Schachter" etc. is never left on screen.
//
// NOTE: each .ac-panel now wraps its content in a .ac-panel-wrapper (the
// element the accordion animates). All post/empty-state rendering targets that
// wrapper — see renderPostsToPanel — so injected content stays inside it.
//
// Guard variables _queueLoadInFlight / _queueLoadDone are module-scope so the
// function is safe to call repeatedly (e.g. from a double-registered handler).

async function initQueueLoad() {
    if (_queueLoadDone || _queueLoadInFlight) return;
    _queueLoadInFlight = true;

    try {
        const containers = document.querySelectorAll(
            '.new-floating-sidebar__content-scroll > .accordion-container'
        );
        const speakersContainer = containers[0]; // Speakers tab
        const shiurimContainer = containers[1]; // Shiurim tab
        const collectionsContainer = containers[2]; // Collections tab
        const previewTabs = document.querySelector('.new-floating-sidebar__preview-tabs');

        if (!speakersContainer && !shiurimContainer && !collectionsContainer && !previewTabs) {
            return;
        }

        const [queueResult, favoritesResult] = await Promise.allSettled([
            fetchQueue(),
            fetchFavorites()
        ]);

        const queueData = queueResult.status === 'fulfilled' ? queueResult.value : null;
        const favoritesData = favoritesResult.status === 'fulfilled' ? favoritesResult.value : null;

        if (queueResult.status === 'rejected') console.warn('initQueueLoad queue:', queueResult.reason);
        if (favoritesResult.status === 'rejected') console.warn('initQueueLoad favorites:', favoritesResult.reason);

        // Speakers tab: panel 0 from favorites, panel 1 from queue.
        if (speakersContainer) {
            if (favoritesData) {
                renderFavoriteSpeakers(favoritesData, speakersContainer);
            } else {
                renderPostsToPanel(nthAcPanel(speakersContainer, 0), [], null, 'No favorite speakers yet.');
            }
            if (queueData) {
                renderRecentSpeakers(queueData, speakersContainer);
            } else {
                renderPostsToPanel(nthAcPanel(speakersContainer, 1), [], null, 'No recent speakers yet.');
            }
        }

        // Shiurim tab: both panels from queue.
        if (shiurimContainer) {
            if (queueData) renderShiurimTabs(queueData, shiurimContainer);
            else clearShiurimTab(shiurimContainer);
        }

        // Collections tab: from favorites.
        if (collectionsContainer) {
            if (favoritesData) renderFavoriteCollections(favoritesData, collectionsContainer);
            else clearCollections(collectionsContainer);
        }

        // Preview thumbnails: speakers column from favorites; other columns wiped.
        if (previewTabs) {
            if (favoritesData) renderFavoriteSpeakerThumbnails(favoritesData, previewTabs);
            else clearPreviewThumbnails(previewTabs);
        }

        _queueLoadDone = true;

        // If a search query was typed during the fetch, apply it to the
        // newly-rendered posts so nothing slips through filtered out.
        reapplyCurrentSidebarFilter();
    } catch (err) {
        console.warn('initQueueLoad failed:', err);
    } finally {
        _queueLoadInFlight = false;
    }
}

async function fetchQueue() {
    const url = '/Queue/queue?action=get&shiurID=0&bookmarkType=queue&sortIndex=0&historySearchTerm=&_=' + Date.now();
    const res = await fetch(url, {
        credentials: 'same-origin',
        headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('Queue request failed: ' + res.status);
    const payload = await res.json();
    if (payload.isError) throw new Error(payload.errorMessage || 'Queue returned an error');
    return payload.data || {};
}

async function fetchFavorites() {
    const body = new URLSearchParams({
        action: 'none',
        myFavoriteType: 'none',
        myFavoriteID: '0'
    });
    const res = await fetch('/Account/UserFavorites', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });
    if (!res.ok) throw new Error('Favorites request failed: ' + res.status);
    const payload = await res.json();
    if (payload && payload.errorMessage) throw new Error(payload.errorMessage);
    return payload || {};
}

// ───────── Speakers tab ─────────

// "My speakers" panel: from /Account/UserFavorites.myFavoriteTeachers. Each
// card shows the teacher and their last 3 shiurim. Unlike the queue-driven
// version this used to be, there's no per-shiur progress bar — favorites
// carry no playback state.
function renderFavoriteSpeakers(favorites, container) {
    const teachers = (favorites && favorites.myFavoriteTeachers) || [];
    renderPostsToPanel(
        nthAcPanel(container, 0),
        teachers,
        renderFavoriteSpeakerPost,
        'No favorite speakers yet.'
    );
}

function renderFavoriteSpeakerPost(teacher, idx) {
    // Note the field name difference from the queue endpoint:
    //   queue:     teacher.teacherName
    //   favorites: teacher.teacherFullName
    const name = teacher.teacherFullName || '';
    const photo = teacher.teacherPhotoURL || '';
    const href = teacher.landingPageURL || '#';
    const avatarImgs = photo
        ? `<img src="${escAttr(photo)}" alt="profile photo"><img src="${escAttr(photo)}" alt="profile photo">`
        : '';

    const episodes = (teacher.last3Shiurim || []).map(shiur => {
        // shiurLectureURL is null on this endpoint; fall back to /lectures/{id}.
        const lectureURL = shiur.shiurLectureURL || `/lectures/${shiur.shiurID}`;
        return `
            <a href="${escAttr(lectureURL)}" class="new-post__ellipsis">
                ${escHtml(shiur.shiurTitle || '')}
            </a>`;
    }).join('');

    // Only the first card carries the "Latest Episodes" label in the mock.
    const latestLabel = idx === 0 ? '<p class="new-post__latest">Latest Episodes</p>' : '';

    return `
<div class="new-post new-post--followed">
    <a class="new-post__link" href="${escAttr(href)}"></a>
    <div>
        <div>
            <div class="new-post__credentials">
                <div class="new-post__image avatar-new avatar--lg">${avatarImgs}</div>
                <div><h5>${escHtml(name)}</h5></div>
            </div>
        </div>
        ${latestLabel}
        <div class="new-post__content">${episodes}</div>
        <a href="${escAttr(href)}" class="new-green-button">
            <span>See More</span>
        </a>
    </div>
</div>`;
}

// "Speakers recently listened to": only includes teachers from queue items
// that were played or have a non-zero bookmark, deduped to most recent date.
// Still queue-driven — no equivalent concept in /Account/UserFavorites.
function renderRecentSpeakers(data, container) {
    const queue = (data && data.shiurQueue) || [];
    const shiurim = (data && data.shiurim) || [];
    const shiurMap = new Map(shiurim.map(s => [s.shiurID, s]));

    const map = new Map();
    queue.forEach(q => {
        const wasPlayed = q.usbIsPlayed === 1 || (q.usbBookmarkTimeStamp && q.usbBookmarkTimeStamp > 0);
        if (!wasPlayed) return;
        const shiur = shiurMap.get(q.shiurID);
        if (!shiur || !shiur.shiurTeachers || !shiur.shiurTeachers.length) return;
        const when = new Date(q.usbDatePlayed || q.usbDateAddedToQueue);
        shiur.shiurTeachers.forEach(teacher => {
            const existing = map.get(teacher.teacherID);
            if (!existing || existing.lastDate < when) {
                map.set(teacher.teacherID, { teacher, lastDate: when });
            }
        });
    });

    const speakers = Array.from(map.values())
        .sort((a, b) => b.lastDate - a.lastDate);

    renderPostsToPanel(
        nthAcPanel(container, 1), // "Speakers recently listened to"
        speakers,
        renderRecentSpeakerPost,
        'No recent speakers yet.'
    );
}

function renderRecentSpeakerPost({ teacher }) {
    const name = teacher.teacherName || '';
    const photo = teacher.teacherPhotoURL || '';
    const href = teacher.landingPageURL || '#';
    const avatarImgs = photo
        ? `<img src="${escAttr(photo)}" alt="profile photo"><img src="${escAttr(photo)}" alt="profile photo">`
        : '';

    return `
<div class="new-post">
    <a class="new-post__link" href="${escAttr(href)}"></a>
    <div>
        <div class="new-post__credentials">
            <div class="new-post__image avatar-new avatar--lg">${avatarImgs}</div>
            <div>
                <h5>${escHtml(name)}</h5>
                <a href="#" class="new-author__follow" data-action="follow" data-teacher-id="${teacher.teacherID}">
                    <span>Follow</span>
                </a>
            </div>
        </div>
    </div>
</div>`;
}

function clearSpeakersTab(container) {
    renderPostsToPanel(nthAcPanel(container, 0), [], null, 'No favorite speakers yet.');
    renderPostsToPanel(nthAcPanel(container, 1), [], null, 'No recent speakers yet.');
}

// ───────── Shiurim tab ─────────

// Recently Played: items with usbIsPlayed===1 or usbBookmarkTimeStamp>0,
// sorted by newest play (falling back to added date).
// Watch Later: everything else, sorted by newest added.
function renderShiurimTabs(data, container) {
    const queue = (data && data.shiurQueue) || [];
    const shiurim = (data && data.shiurim) || [];
    const shiurMap = new Map(shiurim.map(s => [s.shiurID, s]));

    const recent = [], later = [];
    queue.forEach(q => {
        const shiur = shiurMap.get(q.shiurID);
        if (!shiur) return;
        const wasPlayed = q.usbIsPlayed === 1 || (q.usbBookmarkTimeStamp && q.usbBookmarkTimeStamp > 0);
        (wasPlayed ? recent : later).push({ q, shiur });
    });

    recent.sort((a, b) => {
        const da = new Date(a.q.usbDatePlayed || a.q.usbDateAddedToQueue);
        const db = new Date(b.q.usbDatePlayed || b.q.usbDateAddedToQueue);
        return db - da;
    });
    later.sort((a, b) => new Date(b.q.usbDateAddedToQueue) - new Date(a.q.usbDateAddedToQueue));

    renderPostsToPanel(
        nthAcPanel(container, 0),
        recent,
        e => renderShiurPost(e, true),
        'No recently played shiurim yet.'
    );
    renderPostsToPanel(
        nthAcPanel(container, 1),
        later,
        e => renderShiurPost(e, false),
        'Nothing saved for later.'
    );
}

function renderShiurPost({ q, shiur }, showProgress) {
    const teacher = (shiur.shiurTeachers && shiur.shiurTeachers[0]) || {};
    const photo = teacher.teacherPhotoURL || '';
    const teacherName = teacher.teacherName || '';
    const title = shiur.shiurTitle || '';
    const url = shiur.shiurLectureURL || '#';
    const avatarImgs = photo
        ? `<img src="${escAttr(photo)}" alt="profile photo"><img src="${escAttr(photo)}" alt="profile photo">`
        : '';

    let progressHtml = '';
    if (showProgress) {
        const totalSec = parseShiurLengthSeconds(shiur.shiurLength);
        const pct = q.usbIsPlayed === 1
            ? 100
            : (totalSec > 0 && q.usbBookmarkTimeStamp > 0
                ? Math.min(100, Math.round((q.usbBookmarkTimeStamp / totalSec) * 100))
                : 0);
        const check = pct === 100
            ? `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect width="13" height="13" rx="6.5" fill="#FF8D28"/>
                  <path d="M5.68511 8.5L3.78906 6.60395L4.26308 6.12994L5.68511 7.55198L8.73709 4.5L9.2111 4.97401L5.68511 8.5Z" fill="white"/>
               </svg>`
            : '';
        progressHtml = `
            <div class="new-post__progress">
                <div style="width: ${pct}%"></div>
                ${check}
            </div>`;
    }

    return `
<div class="new-post">
    <a class="new-post__link" href="${escAttr(url)}"></a>
    <div>
        <div class="new-post__credentials">
            <div class="new-post__image avatar-new avatar--lg">${avatarImgs}</div>
            <div>
                <h5>${escHtml(title)}</h5>
                <p>${escHtml(teacherName)}</p>
                ${progressHtml}
            </div>
        </div>
    </div>
    <div class="new-post__share-buttons">
        <a href="#" data-action="remove" data-shiur-id="${shiur.shiurID}">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect width="16" height="16" rx="8" fill="#7C7C7C" fill-opacity="0.1"/>
                <path d="M6.13317 10.3332L5.6665 9.8665L7.53317 7.99984L5.6665 6.13317L6.13317 5.6665L7.99984 7.53317L9.8665 5.6665L10.3332 6.13317L8.4665 7.99984L10.3332 9.8665L9.8665 10.3332L7.99984 8.4665L6.13317 10.3332Z" fill="#344054"/>
            </svg>
        </a>
    </div>
</div>`;
}

function clearShiurimTab(container) {
    renderPostsToPanel(nthAcPanel(container, 0), [], null, 'No recently played shiurim yet.');
    renderPostsToPanel(nthAcPanel(container, 1), [], null, 'Nothing saved for later.');
}

// Delegated click handler for the X (remove) button on every shiur queue card.
// Optimistic: hide the post immediately, fire the AJAX call, then either
// commit by removing it from the DOM (success) or restore display (failure).
// URL pattern matches the canonical CFM endpoint:
//   /Queue/queue?action=remove&shiurID={id}&bookmarkType=queue&sortIndex=0
//   &historySearchTerm=&_={ts}
function initShiurRemove() {
    document.addEventListener('click', async function (e) {
        const link = e.target.closest('[data-action="remove"][data-shiur-id]');
        if (!link) return;
        e.preventDefault();
        e.stopPropagation(); // don't trigger the overlay .new-post__link

        const shiurId = link.getAttribute('data-shiur-id');
        if (!shiurId) return;

        const post = link.closest('.new-post');
        if (!post) return;

        // Optimistic hide. We use display rather than remove() so we can
        // restore it cleanly if the request fails.
        const prevDisplay = post.style.display;
        post.style.display = 'none';

        try {
            const url = '/Queue/queue?action=remove'
                + '&shiurID=' + encodeURIComponent(shiurId)
                + '&bookmarkType=queue'
                + '&sortIndex=0'
                + '&historySearchTerm='
                + '&_=' + Date.now();
            const res = await fetch(url, {
                credentials: 'same-origin',
                headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) throw new Error('Remove request failed: ' + res.status);
            // Server may return JSON with an isError flag; check if present.
            try {
                const payload = await res.json();
                if (payload && payload.isError) {
                    throw new Error(payload.errorMessage || 'Remove returned an error');
                }
            } catch (_) {
                // Not JSON, or empty body — treat 2xx as success.
            }
            post.remove();
        } catch (err) {
            console.warn('removeShiurFromQueue:', err);
            post.style.display = prevDisplay;
        }
    });
}

// ───────── Collections tab ─────────

// Collections tab: from /Account/UserFavorites.myFavoriteCollections. Each card
// shows the collection name and last 3 shiurim. All favorites go into the
// first .ac-panel; any additional panels are emptied to keep mock content
// (including the stray "extended post" outside any .ac) from surviving.
function renderFavoriteCollections(favorites, container) {
    if (!container) return;

    // Wipe ALL existing posts and empty-states first, including any stray
    // ones outside an .ac-panel in the cshtml mock.
    container.querySelectorAll('.new-post').forEach(p => p.remove());
    container.querySelectorAll('.new-collection__empty').forEach(p => p.remove());

    // The mock "extended post" now lives inside a .ac-panel-wrapper that sits
    // directly in the container (outside any .ac). Its post was removed above;
    // drop the now-empty stray wrapper so no empty box survives.
    container.querySelectorAll(':scope > .ac-panel-wrapper').forEach(w => w.remove());

    const collections = (favorites && favorites.myFavoriteCollections) || [];
    const panels = container.querySelectorAll(':scope > .ac > .ac-panel');

    if (panels.length > 0) {
        renderPostsToPanel(
            panels[0],
            collections,
            renderFavoriteCollectionPost,
            'No favorite collections yet.'
        );
    }

    // Any other panels — empty state (inside the wrapper).
    for (let i = 1; i < panels.length; i++) {
        const target = panels[i].querySelector(':scope > .ac-panel-wrapper') || panels[i];
        if (target.querySelector('.new-post')) continue;
        if (target.querySelector('.new-collection__empty')) continue;
        const p = document.createElement('p');
        p.className = 'new-collection__empty';
        p.style.display = 'block';
        p.textContent = '';
        target.appendChild(p);
    }
}

function renderFavoriteCollectionPost(collection, idx) {
    const name = collection.name || '';
    const photo = collection.imageURL || '';
    // URL pattern from CollectionDataLayer.GetCollectionById:
    //   /search/?teacher={teacherID}&collection={id}
    const teacherKey = collection.teacherID || 0;
    const href = `/search/?teacher=${teacherKey}&collection=${collection.id}`;
    const avatarImgs = photo
        ? `<img src="${escAttr(photo)}" alt="collection image"><img src="${escAttr(photo)}" alt="collection image">`
        : '';

    const episodes = (collection.last3Shiurim || []).map(shiur => {
        // On this endpoint shiurLectureURL is populated, but fall back just in case.
        const lectureURL = shiur.shiurLectureURL || `/lectures/${shiur.shiurID}`;
        return `
            <a href="${escAttr(lectureURL)}" class="new-post__ellipsis">
                ${escHtml(shiur.shiurTitle || '')}
            </a>`;
    }).join('');

    const latestLabel = idx === 0 ? '<p class="new-post__latest">Latest Episodes</p>' : '';

    return `
<div class="new-post new-post--followed">
    <a class="new-post__link" href="${escAttr(href)}"></a>
    <div>
        <div>
            <div class="new-post__credentials">
                <div class="new-post__image avatar-new avatar--lg">${avatarImgs}</div>
                <div><h5>${escHtml(name)}</h5></div>
            </div>
        </div>
        ${latestLabel}
        <div class="new-post__content">${episodes}</div>
        <a href="${escAttr(href)}" class="new-green-button">
            <span>See More</span>
        </a>
    </div>
</div>`;
}

// Fallback used when the favorites fetch fails: wipe mock posts and show
// neutral empty states on every panel.
function clearCollections(container) {
    if (!container) return;
    container.querySelectorAll('.new-post').forEach(p => p.remove());
    // Drop the stray mock "extended post" wrapper (outside any .ac) too.
    container.querySelectorAll(':scope > .ac-panel-wrapper').forEach(w => w.remove());

    container.querySelectorAll('.ac-panel').forEach(panel => {
        const target = panel.querySelector(':scope > .ac-panel-wrapper') || panel;
        if (target.querySelector('.new-post')) return;
        if (target.querySelector('.new-collection__empty')) return;
        const p = document.createElement('p');
        p.className = 'new-collection__empty';
        p.style.display = 'block';
        p.textContent = 'No collections yet.';
        target.appendChild(p);
    });
}

// ───────── Preview thumbnails (right-edge tooltip column) ─────────

// The preview pane on the floating sidebar has three vertical thumbnail
// columns matching the main tabs. We populate the first (Speakers) with
// teacher avatars from /Account/UserFavorites.myFavoriteTeachers. The
// Shiurim and Collections columns have no thumbnail-friendly source, so
// they're wiped — better empty than misleading.
function renderFavoriteSpeakerThumbnails(favorites, previewTabs) {
    if (!previewTabs) return;
    const cols = previewTabs.querySelectorAll('.new-floating-sidebar__thumbnails-column');

    const speakersCol = cols[0];
    if (speakersCol) {
        const teachers = (favorites && favorites.myFavoriteTeachers) || [];
        speakersCol.innerHTML = teachers.map(renderFavoriteTeacherThumbnail).join('');
    }

    // Shiurim and Collections columns: no data source. Wipe them so the
    // hardcoded "Rabbi Daniel Reich" mocks don't survive on those tabs.
    for (let i = 1; i < cols.length; i++) {
        cols[i].innerHTML = '';
    }
}

function renderFavoriteTeacherThumbnail(teacher) {
    // Favorites endpoint uses teacherFullName (not teacherName).
    const name = teacher.teacherFullName || '';
    const photo = teacher.teacherPhotoURL || '';
    const href = teacher.landingPageURL || '#';
    const avatarImgs = photo
        ? `<img src="${escAttr(photo)}" alt="profile photo"><img src="${escAttr(photo)}" alt="profile photo">`
        : '';

    // data-href + cursor:pointer rather than wrapping in <a> so we don't risk
    // breaking any CSS that targets the column's > div children. The click
    // handler is delegated on document — see initThumbnailClicks().
    return `
<div class="new-floating-sidebar__teacher-thumb" data-href="${escAttr(href)}" style="cursor: pointer;">
    <div class="new-post__image avatar">${avatarImgs}</div>
    <div class="new-post__tooltip">
        <svg width="7" height="10" viewBox="0 0 7 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 0L0 5L7 10V0Z" fill="white"/>
        </svg>
        <span>${escHtml(name)}</span>
    </div>
</div>`;
}

// Delegated click handler for the teacher thumbnails in the preview column.
// Navigates to the teacher landing page on click.
function initThumbnailClicks() {
    document.addEventListener('click', e => {
        const thumb = e.target.closest('.new-floating-sidebar__teacher-thumb[data-href]');
        if (!thumb) return;
        const href = thumb.getAttribute('data-href');
        if (href && href !== '#') {
            window.location.href = href;
        }
    });
}

function clearPreviewThumbnails(previewTabs) {
    if (!previewTabs) return;
    previewTabs.querySelectorAll('.new-floating-sidebar__thumbnails-column').forEach(c => {
        c.innerHTML = '';
    });
}

// ───────── Sidebar search (client-side) ─────────

// Plain text-content filter applied across every .new-post element in the
// floating sidebar. Case-insensitive substring match. The non-active tabs are
// already hidden by CSS so the filter quietly applies to them too — meaning
// switching tabs with a query in place keeps the filter applied.
//
// The selector below tries common patterns. If your search box has a specific
// class, tightening this selector is a behaviour-neutral cleanup.
function initSidebarSearch() {
    const sidebar = document.querySelector('.new-floating-sidebar');
    if (!sidebar) return;

    const input = findSidebarSearchInput(sidebar);
    if (!input) return;

    input.addEventListener('keyup', () => applySidebarFilter(input.value));
}

function findSidebarSearchInput(sidebar) {
    return sidebar.querySelector(
        '.new-floating-sidebar__search input, ' +
        'input[type="search"], ' +
        'input[type="text"], ' +
        'input:not([type])'
    );
}

function applySidebarFilter(query) {
    const sidebar = document.querySelector('.new-floating-sidebar');
    if (!sidebar) return;
    const q = (query || '').trim().toLowerCase();

    sidebar.querySelectorAll('.new-post').forEach(post => {
        if (!q) {
            post.style.display = '';
            return;
        }
        const text = (post.textContent || '').toLowerCase();
        post.style.display = text.includes(q) ? '' : 'none';
    });
}

// Called after initQueueLoad finishes rendering so any in-flight search query
// gets applied to the newly-rendered posts.
function reapplyCurrentSidebarFilter() {
    const sidebar = document.querySelector('.new-floating-sidebar');
    if (!sidebar) return;
    const input = findSidebarSearchInput(sidebar);
    if (input && input.value) {
        applySidebarFilter(input.value);
    }
}

// ───────── Shared helpers ─────────

// Direct .ac child at index n, returns its .ac-panel (or null).
function nthAcPanel(container, n) {
    if (!container) return null;
    const acs = container.querySelectorAll(':scope > .ac');
    const ac = acs[n];
    return ac ? ac.querySelector(':scope > .ac-panel') : null;
}

// Clears existing .new-post / empty-state elements in a panel, then renders
// items in front of any panel-level "See All" green button (e.g. Watch Later).
//
// Content lives inside .ac-panel > .ac-panel-wrapper (the element the accordion
// animates), so we resolve that wrapper and do all removal/insertion there. The
// "See All" button is a direct child of the wrapper too. Falls back to the panel
// itself for any panel that has no wrapper.
function renderPostsToPanel(panel, items, renderItem, emptyMessage) {
    if (!panel) return;
    const target = panel.querySelector(':scope > .ac-panel-wrapper') || panel;

    target.querySelectorAll('.new-post').forEach(p => p.remove());
    target.querySelectorAll('.new-collection__empty').forEach(p => p.remove());

    const seeAll = target.querySelector(':scope > .new-green-button');

    if (!items || !items.length) {
        const p = document.createElement('p');
        p.className = 'new-collection__empty';
        p.style.display = 'block';
        p.textContent = emptyMessage || '';
        if (seeAll) target.insertBefore(p, seeAll);
        else target.appendChild(p);
        return;
    }

    const tmp = document.createElement('div');
    tmp.innerHTML = items.map((item, idx) => renderItem(item, idx)).join('');
    while (tmp.firstChild) {
        if (seeAll) target.insertBefore(tmp.firstChild, seeAll);
        else target.appendChild(tmp.firstChild);
    }
}

// "00:47:12" or "00:47:12.5670000" → seconds (number).
function parseShiurLengthSeconds(s) {
    if (!s) return 0;
    const parts = String(s).split(':');
    if (parts.length !== 3) return 0;
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    const sec = parseFloat(parts[2]) || 0;
    return h * 3600 + m * 60 + sec;
}

function escHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]
    ));
}
function escAttr(s) { return escHtml(s); }