(async function() {
    // --- 設定 ---
    const SCROLL_DELAY = 3000; // スクロール待機時間(ミリ秒)
    
    // ==========================================
    // 追加機能: 日数指定による収集範囲の制限
    // ==========================================
    const daysInput = prompt("【日数指定】\n何日分さかのぼって保存しますか？\n\n・入力あり (例: 30) → 直近30日分のみ保存\n・入力なし (空欄/キャンセル) → 全ツイート保存", "");
    
    let cutoffDate = null;
    if (daysInput && /^\d+$/.test(daysInput) && parseInt(daysInput) > 0) {
        cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(daysInput));
        // 時間を00:00:00にして、指定日の開始時点より前かを判定できるようにする
        cutoffDate.setHours(0, 0, 0, 0);
        console.log(`>>> 設定: 直近 ${daysInput} 日間 (${cutoffDate.toLocaleString()} 以降) のツイートのみを収集します。`);
    } else {
        console.log(">>> 設定: 期間指定なし。可能な限りすべてのツイートを収集します。");
    }
    // ==========================================

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

    // --- プロフィール情報の取得 ---
    let profileData = { name: TARGET_ID, screenName: "@" + TARGET_ID, avatarUrl: "", following: "0", followers: "0" };
    
    // 画面から数値などを取得
    try {
        const followingLink = document.querySelector(`a[href*="/${TARGET_ID}/following"]`);
        if (followingLink) profileData.following = followingLink.innerText.match(/[\d,]+([.][\d]+)?([KMGT万億])?/)?.[0] || "0";
        
        const followersLink = document.querySelector(`a[href*="/${TARGET_ID}/verified_followers"]`) || document.querySelector(`a[href*="/${TARGET_ID}/followers"]`);
        if (followersLink) profileData.followers = followersLink.innerText.match(/[\d,]+([.][\d]+)?([KMGT万億])?/)?.[0] || "0";

        const avatarContainer = document.querySelector(`div[data-testid*="Tweet-User-Avatar"]`);
        if (avatarContainer) {
            const img = avatarContainer.querySelector('img');
            if (img) profileData.avatarUrl = img.src;
        }

        const nameEl = document.querySelector('div[data-testid="UserName"] span span');
        if (nameEl) profileData.name = nameEl.innerText;
    } catch(e) {}

    // 取得できない場合は入力
    if (profileData.following === "0" || profileData.followers === "0") {
        const inputFollowing = prompt(`@${TARGET_ID} の【フォロー数】を入力 (例: 212)`, profileData.following !== "0" ? profileData.following : "");
        const inputFollowers = prompt(`@${TARGET_ID} の【フォロワー数】を入力 (例: 2,381)`, profileData.followers !== "0" ? profileData.followers : "");
        if (inputFollowing) profileData.following = inputFollowing;
        if (inputFollowers) profileData.followers = inputFollowers;
    }

    console.log(`>>> @${TARGET_ID} の収集を開始します...`);

    // ------------------------------------------------
    // React内部データ解析用の関数群
    // ------------------------------------------------

    function getReactFiber(el) {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        return key ? el[key] : null;
    }

    function findTweetDataInFiber(fiber) {
        let curr = fiber;
        while (curr) {
            const memoizedProps = curr.memoizedProps;
            if (memoizedProps && memoizedProps.item && memoizedProps.item.content && memoizedProps.item.content.tweetResult) {
                return memoizedProps.item.content.tweetResult.result;
            }
            if (memoizedProps && memoizedProps.tweet) {
                return memoizedProps.tweet;
            }
            curr = curr.return;
        }
        return null;
    }

    function extractMediaFromData(tweetData) {
        const mediaList = [];
        const legacy = tweetData.legacy || tweetData;
        
        if (legacy.extended_entities && legacy.extended_entities.media) {
            legacy.extended_entities.media.forEach(m => {
                if (m.type === 'video' || m.type === 'animated_gif') {
                    if (m.video_info && m.video_info.variants) {
                        const variants = m.video_info.variants
                            .filter(v => v.content_type === 'video/mp4')
                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                        
                        if (variants.length > 0) {
                            mediaList.push(variants[0].url);
                        }
                    }
                } else if (m.media_url_https) {
                    mediaList.push(m.media_url_https);
                }
            });
        } else if (legacy.entities && legacy.entities.media) {
             legacy.entities.media.forEach(m => mediaList.push(m.media_url_https));
        }
        return mediaList;
    }

    // ------------------------------------------------

    const collectedTweets = new Map();
    let lastHeight = 0;
    let noChangeCount = 0;
    let consecutiveOldTweetsCount = 0; // 指定日付より古いツイートが連続した回数
    let stopScraping = false; // ループ停止フラグ

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
            const voteMatch = pollRoot.innerText.match(/([\d,]+)\s*(票|votes)/);
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

            if (!profileData.avatarUrl) {
                const img = article.querySelector('div[data-testid="Tweet-User-Avatar"] img');
                if (img) profileData.avatarUrl = img.src;
            }
            if (profileData.name === TARGET_ID) {
                const nameAnchor = article.querySelector('div[data-testid="User-Name"] a');
                if (nameAnchor) profileData.name = nameAnchor.innerText;
            }

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

            let images = [];
            const fiber = getReactFiber(article);
            const tweetInternalData = findTweetDataInFiber(fiber);
            if (tweetInternalData) {
                const mediaFromReact = extractMediaFromData(tweetInternalData);
                if (mediaFromReact.length > 0) {
                    images = mediaFromReact;
                }
            }

            if (images.length === 0) {
                article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach(img => {
                    let src = img.src;
                    if (src.includes('tweet_video_thumb')) {
                        src = src.replace('pbs.twimg.com/tweet_video_thumb', 'video.twimg.com/tweet_video').replace(/\.[^.]+$/, '.mp4');
                    }
                    images.push(src);
                });
            }

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
            if (stopScraping) return; // 既に停止フラグが立っていたら処理しない

            const data = getTweetData(article);
            if (data && !collectedTweets.has(data.id)) {
                
                // === 日付チェック機能 ===
                if (cutoffDate) {
                    const tweetDate = new Date(data.date);
                    if (tweetDate < cutoffDate) {
                        // 指定日より古いツイートの場合
                        consecutiveOldTweetsCount++;
                        
                        // 連続して古いツイートが見つかったら収集停止とみなす
                        // (固定ツイートなどは古くても1つだけなので、連続5件を閾値とする)
                        if (consecutiveOldTweetsCount >= 5) {
                            stopScraping = true;
                        }
                        
                        // 保存対象にしないため、ここで return
                        return;
                    } else {
                        // 新しいツイートが見つかったらカウンターをリセット
                        // (固定ツイートより下のタイムラインがまだ新しい場合など)
                        consecutiveOldTweetsCount = 0;
                    }
                }
                // ========================

                collectedTweets.set(data.id, data);
                let info = "";
                if (data.images.some(u => u.includes('.mp4'))) info += "[動画] ";
                if (data.poll) info += "[投票] ";
                console.log(`取得: ${info}${data.text.substring(0, 15)}...`);
            }
        });

        // 日付制限により停止する場合
        if (stopScraping) {
            console.log(">>> 指定された期間を過ぎたため、収集を終了します。");
            break;
        }

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
