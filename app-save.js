(async function() {
    // --- 設定 ---
    const SCROLL_DELAY = 3000; // スクロール待機時間(ミリ秒)
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

    // DOM要素からReactの内部インスタンス(Fiber)を取得する
    function getReactFiber(el) {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        return key ? el[key] : null;
    }

    // Fiberツリーを遡ってツイートデータを探す
    function findTweetDataInFiber(fiber) {
        let curr = fiber;
        while (curr) {
            // legacyプロパティ（ツイート詳細）を持っているかチェック
            const memoizedProps = curr.memoizedProps;
            if (memoizedProps && memoizedProps.item && memoizedProps.item.content && memoizedProps.item.content.tweetResult) {
                return memoizedProps.item.content.tweetResult.result;
            }
            // 直接的なtweetデータを持っている場合
            if (memoizedProps && memoizedProps.tweet) {
                return memoizedProps.tweet;
            }
            curr = curr.return; // 親ノードへ
        }
        return null;
    }

    // ツイートデータからメディア(動画含む)を抽出
    function extractMediaFromData(tweetData) {
        const mediaList = [];
        const legacy = tweetData.legacy || tweetData; // 構造による違いを吸収
        
        if (legacy.extended_entities && legacy.extended_entities.media) {
            legacy.extended_entities.media.forEach(m => {
                // 動画(video)またはGIF(animated_gif)の場合
                if (m.type === 'video' || m.type === 'animated_gif') {
                    if (m.video_info && m.video_info.variants) {
                        // 最もビットレートが高いmp4を選ぶ
                        const variants = m.video_info.variants
                            .filter(v => v.content_type === 'video/mp4')
                            .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                        
                        if (variants.length > 0) {
                            mediaList.push(variants[0].url);
                        }
                    }
                } else if (m.media_url_https) {
                    // 通常の画像
                    mediaList.push(m.media_url_https);
                }
            });
        } else if (legacy.entities && legacy.entities.media) {
             // 単一画像などのフォールバック
             legacy.entities.media.forEach(m => mediaList.push(m.media_url_https));
        }
        return mediaList;
    }

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

            // 名前などの補完
            if (!profileData.avatarUrl) {
                const img = article.querySelector('div[data-testid="Tweet-User-Avatar"] img');
                if (img) profileData.avatarUrl = img.src;
            }
            if (profileData.name === TARGET_ID) {
                const nameAnchor = article.querySelector('div[data-testid="User-Name"] a');
                if (nameAnchor) profileData.name = nameAnchor.innerText;
            }

            // テキスト取得
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

            // === メディア取得の強化部分 ===
            let images = [];
            
            // A. React内部データから高画質動画・画像を探す (推奨)
            const fiber = getReactFiber(article);
            const tweetInternalData = findTweetDataInFiber(fiber);
            if (tweetInternalData) {
                const mediaFromReact = extractMediaFromData(tweetInternalData);
                if (mediaFromReact.length > 0) {
                    images = mediaFromReact;
                }
            }

            // B. もしReact解析に失敗したら、画面上のimgタグから取得 (フォールバック)
            if (images.length === 0) {
                article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach(img => {
                    let src = img.src;
                    if (src.includes('tweet_video_thumb')) {
                        // GIF動画の簡易変換
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
                images: images, // 重複除去やmp4が優先されている
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
                if (data.images.some(u => u.includes('.mp4'))) info += "[動画] ";
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