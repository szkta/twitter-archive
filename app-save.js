(async function() {
    // --- 設定 ---
    const SCROLL_DELAY = 3000;
    // ------------

    // 1. URLからターゲットIDを特定
    let TARGET_ID = "";
    const pathParts = window.location.pathname.split('/');
    
    if (pathParts[1] === "search") {
        const urlParams = new URLSearchParams(window.location.search);
        const query = urlParams.get('q');
        if (query) {
            const match = query.match(/from:([a-zA-Z0-9_]+)/i);
            if (match) TARGET_ID = match[1];
        }
        if (!TARGET_ID) {
            const searchInput = document.querySelector('input[data-testid="SearchBox_Search_Input"]');
            if (searchInput && searchInput.value.includes('from:')) {
                const match = searchInput.value.match(/from:@([a-zA-Z0-9_]+)/i);
                if (match) TARGET_ID = match[1];
            }
        }
    } else {
        TARGET_ID = pathParts[1];
    }

    if (!TARGET_ID) {
        console.error("エラー：ユーザーIDが特定できませんでした。");
        return;
    }

    // --- プロフィール数値の取得（自動取得 or 手動入力） ---
    let followingCount = "0";
    let followersCount = "0";
    let avatarUrl = "";
    let userName = TARGET_ID;

    // 1. まず現在の画面から探してみる（プロフィール画面用）
    try {
        // フォロー数
        const followingLink = document.querySelector(`a[href*="/${TARGET_ID}/following"]`);
        if (followingLink) {
            const match = followingLink.innerText.match(/[\d,]+([.][\d]+)?([KMGT万億])?/);
            if (match) followingCount = match[0];
        }
        // フォロワー数
        const followersLink = document.querySelector(`a[href*="/${TARGET_ID}/verified_followers"]`) 
                           || document.querySelector(`a[href*="/${TARGET_ID}/followers"]`);
        if (followersLink) {
            const match = followersLink.innerText.match(/[\d,]+([.][\d]+)?([KMGT万億])?/);
            if (match) followersCount = match[0];
        }
        // アイコン
        const avatarContainer = document.querySelector(`div[data-testid="UserAvatar-Container-${TARGET_ID}"]`) 
                             || document.querySelector(`div[data-testid="UserAvatar-Container-${TARGET_ID.toLowerCase()}"]`);
        if (avatarContainer) {
            const img = avatarContainer.querySelector('img');
            if (img) avatarUrl = img.src;
        }
        // 名前（プロフィール画面用）
        const primaryCol = document.querySelector('div[data-testid="primaryColumn"]');
        if (primaryCol) {
            const nameEl = primaryCol.querySelector('div[data-testid="UserName"] span span');
            if (nameEl) userName = nameEl.innerText;
        }
    } catch(e) {}

    // 2. 取得できなかった場合（検索画面など）、ユーザーに入力してもらう
    // ※ 検索画面ではここで一旦 "0" のまま進み、後述のgetTweetData内で補完されることを期待します
    if (followingCount === "0" || followersCount === "0") {
        // ここでのプロンプトは邪魔になる可能性があるため、検索画面で運用する場合はコメントアウトしても良いかもしれません
        // 今回は元のロジックを維持します
        const inputFollowing = prompt(`@${TARGET_ID} の【フォロー数】を入力してください\n(例: 212)`, followingCount !== "0" ? followingCount : "");
        const inputFollowers = prompt(`@${TARGET_ID} の【フォロワー数】を入力してください\n(例: 2,381)`, followersCount !== "0" ? followersCount : "");
        
        if (inputFollowing) followingCount = inputFollowing;
        if (inputFollowers) followersCount = inputFollowers;
    }

    const profileData = {
        name: userName,
        screenName: "@" + TARGET_ID,
        avatarUrl: avatarUrl,
        following: followingCount,
        followers: followersCount
    };

    console.log(`>>> @${TARGET_ID} の収集を開始します...`);
    console.log("プロフィールデータ:", profileData);

    // ------------------------------------------------

    const collectedTweets = new Map();
    let lastHeight = 0;
    let noChangeCount = 0;

    function getPollData(article) {
        try {
            const pollRoot = article.querySelector('[data-testid="cardPoll"]');
            if (!pollRoot) return null;
            const options = [];
            const listItems = pollRoot.querySelectorAll('li[role="listitem"]');
            if (listItems.length === 0) return null;
            listItems.forEach(li => {
                const lines = li.innerText.split('\n').filter(line => line.trim() !== "");
                let percent = 0;
                let label = "";
                const percentIndex = lines.findIndex(line => /^\d+(\.\d+)?%$/.test(line));
                if (percentIndex !== -1) {
                    percent = parseFloat(lines[percentIndex].replace('%', ''));
                    label = lines.slice(0, percentIndex).join(" ");
                } else {
                    label = lines[0];
                }
                options.push({ label: label, percent: percent });
            });
            let totalVotes = 0;
            const footerText = pollRoot.innerText;
            const voteMatch = footerText.match(/([\d,]+)\s*(票|votes)/);
            if (voteMatch) totalVotes = parseInt(voteMatch[1].replace(/,/g, ''), 10);
            if (options.length > 0) return { options: options, total_votes: totalVotes };
        } catch (e) { return null; }
        return null;
    }

    function getTweetData(article) {
        try {
            const userLinks = article.querySelectorAll('div[data-testid="User-Name"] a');
            if (userLinks.length === 0) return null;

            let isTargetUser = false;
            for (const link of userLinks) {
                const href = link.getAttribute('href');
                if (href && href.toLowerCase().endsWith(`/${TARGET_ID.toLowerCase()}`)) {
                    isTargetUser = true;
                    break;
                }
            }
            if (!isTargetUser) return null;

            // --- 修正箇所ここから ---
            
            // 1. アイコンの補完
            if (!profileData.avatarUrl) { 
                try {
                    const avatarImg = article.querySelector('div[data-testid="Tweet-User-Avatar"] img');
                    if (avatarImg) profileData.avatarUrl = avatarImg.src;
                } catch (e) {}
            }

            // 2. 名前の補完
            // プロフィールデータがまだIDのままであれば、ツイート情報から取得を試みる
            if (profileData.name === TARGET_ID) {
                try {
                    const userNameDiv = article.querySelector('div[data-testid="User-Name"]');
                    if (userNameDiv) {
                        // 【変更点】
                        // div全体のinnerTextではなく、内部にある最初のアンカータグ(a)のテキストを取得する。
                        // 検索画面の構造では、最初のaタグが表示名、次の要素が@IDとなっているため。
                        const nameAnchor = userNameDiv.querySelector('a');
                        if (nameAnchor) {
                            const nameText = nameAnchor.innerText;
                            if (nameText) {
                                profileData.name = nameText;
                                console.log("ユーザー名を補完しました:", nameText); // 確認用ログ
                            }
                        }
                    }
                } catch (e) {}
            }
            
            // --- 修正箇所ここまで ---

            const textEl = article.querySelector('div[data-testid="tweetText"]');
            let text = "";
            if (textEl) {
                const clone = textEl.cloneNode(true);
                clone.querySelectorAll('img').forEach(img => {
                    const alt = img.getAttribute('alt');
                    if (alt) img.replaceWith(document.createTextNode(alt));
                });
                text = clone.innerText;
            }

            const timeEl = article.querySelector('time');
            if (!timeEl) return null;
            const date = timeEl.getAttribute('datetime');
            const tweetUrl = timeEl.closest('a').getAttribute('href');
            const id = tweetUrl.split('/').pop();

            const images = [];
            article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach(img => {
                let src = img.src;
                if (src.includes('tweet_video_thumb')) {
                    const mp4Src = src.replace('pbs.twimg.com/tweet_video_thumb', 'video.twimg.com/tweet_video')
                                      .replace(/\.(jpg|png|webp).*/, '.mp4');
                    images.push(mp4Src);
                } else {
                    images.push(src);
                }
            });

            const poll = getPollData(article);
            const getMetric = (testId) => {
                const el = article.querySelector(`[data-testid="${testId}"]`);
                return el ? (el.ariaLabel || el.innerText || "0") : "0";
            };

            return {
                id: id,
                date: date,
                text: text,
                url: "https://x.com" + tweetUrl,
                images: images,
                poll: poll,
                metrics: {
                    reply: getMetric("reply"),
                    repost: getMetric("retweet"),
                    like: getMetric("like")
                }
            };
        } catch (e) { return null; }
    }

    while (true) {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => {
            const data = getTweetData(article);
            if (data && !collectedTweets.has(data.id)) {
                collectedTweets.set(data.id, data);
                let info = "";
                if (data.images.some(u => u.endsWith('.mp4'))) info += "[GIF] ";
                if (data.poll) info += "[投票] ";
                console.log(`取得: ${info}${data.text.substring(0, 15)}...`);
            }
        });

        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, SCROLL_DELAY));

        const newHeight = document.body.scrollHeight;
        if (newHeight === lastHeight) {
            noChangeCount++;
            if (noChangeCount >= 3) break; 
        } else {
            noChangeCount = 0;
            lastHeight = newHeight;
        }
    }

    const result = {
        meta: { 
            target: TARGET_ID, 
            exported_at: new Date().toISOString(),
            user_info: profileData 
        },
        posts: Array.from(collectedTweets.values())
    };
    
    const blob = new Blob([JSON.stringify(result, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${TARGET_ID}_tweets_raw.json`;
    link.click();
    console.log(`>>> 完了！ ${result.posts.length} 件のデータを保存しました。`);
})();