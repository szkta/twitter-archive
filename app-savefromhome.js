(async function() {
    // --- 設定 ---
    const TARGET_ID = window.location.pathname.split('/')[1]; 
    const SCROLL_DELAY = 3000;
    // ------------

    if (!TARGET_ID) {
        console.error("ユーザーIDが取得できませんでした。");
        return;
    }

    console.log(`>>> @${TARGET_ID} の収集を開始します...`);

    // プロフィール情報取得
    const profileData = { name: "", screenName: "@" + TARGET_ID, avatarUrl: "" };
    try {
        const primaryCol = document.querySelector('div[data-testid="primaryColumn"]');
        if (primaryCol) {
            const nameEl = primaryCol.querySelector('div[data-testid="UserName"] span span');
            if (nameEl) profileData.name = nameEl.innerText;
        }
        const avatarContainer = document.querySelector(`div[data-testid="UserAvatar-Container-${TARGET_ID}"]`) 
                             || document.querySelector(`div[data-testid="UserAvatar-Container-${TARGET_ID.toLowerCase()}"]`);
        if (avatarContainer) {
            const img = avatarContainer.querySelector('img');
            if (img) profileData.avatarUrl = img.src;
        }
    } catch (e) {}

    const collectedTweets = new Map();
    let lastHeight = 0;
    let noChangeCount = 0;

    // 投票データの解析
    function getPollData(article) {
        try {
            const pollCard = article.querySelector('[data-testid="card.wrapper"]');
            if (!pollCard) return null;

            // 投票の選択肢を探す（プログレスバーがある要素などから推測）
            // XのDOMは変わりやすいため、汎用的な探索を行う
            const options = [];
            const labels = pollCard.querySelectorAll('span'); 
            // 投票コンテナ内のテキスト解析は複雑なため、データ属性を持つ要素を探す
            
            // 選択肢のコンテナ（通常は4つまで）
            const choiceContainers = pollCard.querySelectorAll('[data-testid^="pollOption"]');
            
            if (choiceContainers.length === 0) return null;

            choiceContainers.forEach(container => {
                const label = container.innerText.split('\n')[0]; // 改行の前のテキスト
                const percentText = container.innerText.match(/(\d+(\.\d+)?)%/); // %を探す
                const percent = percentText ? parseFloat(percentText[1]) : 0;
                
                options.push({ label: label, percent: percent });
            });

            // 総投票数の取得 ("1,234票" や "1,234 votes" を探す)
            let totalVotes = 0;
            const footerText = pollCard.innerText;
            const voteMatch = footerText.match(/([\d,]+)\s*(票|votes)/);
            if (voteMatch) {
                totalVotes = parseInt(voteMatch[1].replace(/,/g, ''), 10);
            }

            if (options.length > 0) {
                return { options: options, total_votes: totalVotes };
            }
        } catch (e) {
            return null;
        }
        return null;
    }

    function getTweetData(article) {
        try {
            // リポスト除外
            const userLinks = article.querySelectorAll('div[data-testid="User-Name"] a');
            if (userLinks.length > 0) {
                const href = userLinks[userLinks.length - 1].getAttribute('href');
                if (href && !href.toLowerCase().includes(TARGET_ID.toLowerCase())) {
                    return null;
                }
            }

            // テキスト
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

            // 日付・URL
            const timeEl = article.querySelector('time');
            if (!timeEl) return null;
            const date = timeEl.getAttribute('datetime');
            const tweetUrl = timeEl.closest('a').getAttribute('href');
            const id = tweetUrl.split('/').pop();

            // 画像・GIF検知
            const mediaFiles = [];
            // 通常の画像
            article.querySelectorAll('div[data-testid="tweetPhoto"] img').forEach(img => {
                let src = img.src;
                // GIF動画のサムネイルの場合、mp4のURLに変換する
                if (src.includes('tweet_video_thumb')) {
                    // https://pbs.twimg.com/tweet_video_thumb/XXX.jpg 
                    // -> https://video.twimg.com/tweet_video/XXX.mp4
                    const mp4Src = src.replace('pbs.twimg.com/tweet_video_thumb', 'video.twimg.com/tweet_video')
                                      .replace(/\.(jpg|png|webp).*/, '.mp4');
                    mediaFiles.push(mp4Src);
                } else {
                    mediaFiles.push(src);
                }
            });

            // 投票データ
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
                images: mediaFiles, // 画像と動画URLが混在する
                poll: poll,         // 投票データ（なければnull）
                metrics: {
                    reply: getMetric("reply"),
                    repost: getMetric("retweet"),
                    like: getMetric("like")
                }
            };
        } catch (e) {
            return null;
        }
    }

    // スクロールループ
    while (true) {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        articles.forEach(article => {
            const data = getTweetData(article);
            if (data && !collectedTweets.has(data.id)) {
                collectedTweets.set(data.id, data);
                // ログ表示（GIFや投票があれば表示）
                let info = "";
                if (data.images.some(u => u.endsWith('.mp4'))) info += "[GIFあり] ";
                if (data.poll) info += "[投票あり] ";
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