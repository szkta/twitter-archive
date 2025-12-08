const fileInput = document.getElementById('fileInput');
const dropZone = document.getElementById('dropZone');

const loadedData = {};
let currentUserId = null;
let currentTab = 'posts';

// テーマ切り替え機能
function toggleTheme() {
    // 現在の設定を取得
    const isDark = document.body.dataset.theme === 'dark';
    if (isDark) {
        // ライトモードへ（属性削除）
        delete document.body.dataset.theme;
        localStorage.setItem('theme', 'light');
    } else {
        // ダークモードへ（属性付与）
        document.body.dataset.theme = 'dark';
        localStorage.setItem('theme', 'dark');
    }
}

// 初期ロード時にテーマを復元
(function () {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
        document.body.dataset.theme = 'dark';
    }
})();

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#1d9bf0'; dropZone.style.backgroundColor = 'var(--drop-active)'; });
dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--border-color)'; dropZone.style.backgroundColor = 'var(--bg-color)'; });
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border-color)';
    dropZone.style.backgroundColor = 'var(--bg-color)';
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});

function handleFiles(files) {
    Array.from(files).forEach(file => {
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const json = JSON.parse(e.target.result);
                const targetUser = json.meta?.target || json.meta?.target_user || 'unknown';
                loadedData[targetUser] = json;
                updateSidebar();
                if (!currentUserId) switchUser(targetUser);
            } catch (err) {
                console.error(err);
                alert("読込失敗: " + file.name);
            }
        };
        reader.readAsText(file);
    });
}

function updateSidebar() {
    const container = document.getElementById('accountListSection');
    container.innerHTML = '';
    Object.keys(loadedData).forEach(userId => {
        const data = loadedData[userId];
        const meta = data.meta || {};
        const history = meta.profile_history || [];
        const latest = history.length > 0 ? history[0] : { name: userId, screen_name: "@" + userId, avatar: "" };
        const avatar = latest.avatar ? latest.avatar.replace(/\\/g, '/') : 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png';

        const div = document.createElement('div');
        div.className = `account-item ${currentUserId === userId ? 'active' : ''}`;
        div.onclick = () => switchUser(userId);
        div.innerHTML = `<img src="${avatar}" class="account-icon"><div class="account-info"><span class="account-name">${latest.name}</span><span class="account-id">${latest.screen_name}</span></div>`;
        container.appendChild(div);
    });
}

function switchUser(userId) {
    currentUserId = userId;
    updateSidebar();
    document.getElementById('uploadArea').style.display = 'none';
    document.getElementById('feedArea').style.display = 'block';
    renderHeader(userId);
    renderTimeline(userId);
    window.scrollTo(0, 0);
}

function resetView() {
    currentUserId = null;
    document.getElementById('uploadArea').style.display = 'block';
    document.getElementById('feedArea').style.display = 'none';
    updateSidebar();
}

function renderHeader(userId) {
    const data = loadedData[userId];
    const meta = data.meta || {};
    const history = meta.profile_history || [];
    // 最新プロフィール
    const latest = history.length > 0 ? history[0] : { name: userId, screen_name: "@" + userId, avatar: "" };
    const avatar = latest.avatar ? latest.avatar.replace(/\\/g, '/') : 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png';
    const dateStr = meta.last_updated || meta.execution_date;
    const dateDisplay = dateStr ? new Date(dateStr).toLocaleString('ja-JP') : '不明';

    // ユーザー情報（JSから取得したuser_infoがあればそれを使う）
    const userInfo = meta.user_info || {};
    const following = userInfo.following || "-";
    const followers = userInfo.followers || "-";

    document.getElementById('headerName').innerText = latest.name;
    document.getElementById('headerCount').innerText = `${meta.total_posts_retrieved || 0} 件のツイート`;
    document.getElementById('profileIcon').src = avatar;
    document.getElementById('profileName').innerText = latest.name;
    document.getElementById('profileId').innerText = latest.screen_name;
    document.getElementById('profileDate').innerText = dateDisplay;

    // フォロー数・フォロワー数反映
    document.getElementById('followingCount').innerText = following;
    document.getElementById('followersCount').innerText = followers;
}

window.switchTab = function (type) {
    currentTab = type;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector(`.tab:nth-child(${type === 'posts' ? 1 : 2})`).classList.add('active');
    renderTimeline(currentUserId);
};

function extractNumber(str) {
    if (!str) return '0';
    const match = str.toString().match(/([\d,.]+[KMGT万億]?)/);
    return match ? match[1] : '0';
}

function renderTimeline(userId) {
    const data = loadedData[userId];
    if (!data) return;
    const container = document.getElementById('timeline');
    container.innerHTML = '';

    const posts = data.posts || [];
    const filteredPosts = currentTab === 'media' ? posts.filter(p => p.images && p.images.length > 0) : posts;

    const history = data.meta.profile_history || [];
    const latest = history.length > 0 ? history[0] : { name: userId, screen_name: "@" + userId };
    const avatar = latest.avatar ? latest.avatar.replace(/\\/g, '/') : 'https://abs.twimg.com/sticky/default_profile_images/default_profile_400x400.png';

    if (filteredPosts.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:40px; color:var(--sub-text);">表示するツイートがありません</div>';
        return;
    }

    filteredPosts.forEach(post => {
        let mediaHtml = '';
        if (post.images && post.images.length > 0) {
            let gridClass = `cols-${Math.min(post.images.length, 4)}`;
            mediaHtml = `<div class="media-grid ${gridClass}">`;
            post.images.forEach(media => {
                const path = media.replace(/\\/g, '/');
                if (path.endsWith('.mp4')) mediaHtml += `<video src="${path}" autoplay loop muted playsinline controls></video>`;
                else mediaHtml += `<a href="${path}" target="_blank"><img src="${path}" loading="lazy"></a>`;
            });
            mediaHtml += `</div>`;
        }

        let pollHtml = '';
        if (post.poll) {
            const total = post.poll.total_votes || 0;
            let optionsHtml = '';
            (post.poll.options || []).forEach(opt => {
                const votes = Math.round(total * (opt.percent / 100));
                optionsHtml += `
                <div class="poll-option" title="推定投票数: ${votes}票">
                    <div class="poll-bar-bg"><div class="poll-bar-fill" style="width:${opt.percent}%"></div>
                    <span class="poll-label">${opt.label}</span><span class="poll-percent">${opt.percent}%</span></div>
                </div>`;
            });
            pollHtml = `<div class="poll-container">${optionsHtml}<div style="font-size:13px; color:var(--sub-text); margin-top:5px;">${total.toLocaleString()}票</div></div>`;
        }

        const m = post.metrics || {};
        const replyCount = extractNumber(m.reply);
        const repostCount = extractNumber(m.repost);
        const likeCount = extractNumber(m.like);

        let postDate = '';
        try { 
            if (post.date) {
                const d = new Date(post.date);
                const year = d.getFullYear();
                const month = d.getMonth() + 1; // 0始まりなので+1
                const day = d.getDate();
                const hour = String(d.getHours()).padStart(2, '0'); // 2桁ゼロ埋め
                const min = String(d.getMinutes()).padStart(2, '0');
                const sec = String(d.getSeconds()).padStart(2, '0');
                
                postDate = `${year}年${month}月${day}日 ${hour}:${min}:${sec}`;
            } 
        } catch (e) { }

        const article = document.createElement('article');
        article.className = 'tweet';
        article.onclick = (e) => {
            if (e.target.tagName !== 'A' && e.target.tagName !== 'IMG' && e.target.tagName !== 'VIDEO') {
                window.open(post.url, '_blank');
            }
        };

        article.innerHTML = `
        <div class="tweet-avatar">
            <img src="${avatar}" loading="lazy">
        </div>
        <div class="tweet-content">
            <div class="tweet-header">
                <span class="user-name-bold">${latest.name}</span>
                <span class="user-id-gray">${latest.screen_name}</span>
                <span class="dot-separator">·</span>
                <a href="${post.url}" target="_blank" class="tweet-date">${postDate}</a>
            </div>
            <div class="tweet-text">${post.text}</div>
            ${mediaHtml}
            ${pollHtml}
            <div class="tweet-actions">
                <div class="action-item reply"><svg viewBox="0 0 24 24"><path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01zm8.005-6c-3.317 0-6.005 2.69-6.005 6 0 3.37 2.77 6.08 6.138 6.01l.351-.01h1.761v2.3l5.087-2.81c1.951-1.08 3.163-3.13 3.163-5.36 0-3.39-2.744-6.13-6.129-6.13H9.756z"></path></svg><span class="action-count">${replyCount}</span></div>
                <div class="action-item repost"><svg viewBox="0 0 24 24"><path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z"></path></svg><span class="action-count">${repostCount}</span></div>
                <div class="action-item like"><svg viewBox="0 0 24 24"><path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z"></path></svg><span class="action-count">${likeCount}</span></div>
                <div class="action-item share"><svg viewBox="0 0 24 24"><path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z"></path></svg></div>
            </div>
        </div>
    `;
        container.appendChild(article);
    });

    twemoji.parse(document.body);
}