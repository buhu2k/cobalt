import { createStream } from "../../stream/manage.js";
import { genericUserAgent } from "../../config.js";
import { getCookie, updateCookie } from "../cookie/manager.js";

const commonInstagramHeaders = {
    'User-Agent': genericUserAgent,
    'sec-gpc': '1',
    'Sec-Fetch-Site': 'same-origin',
}

const cachedDtsg = {
    value: '',
    expiry: 0
}

async function findDtsgId(cookie) {
    try {
        if (cachedDtsg.expiry > Date.now()) return cachedDtsg.value;

        const data = await fetch('https://www.instagram.com/', {
            headers: {
                ...commonInstagramHeaders,
                cookie
            }
        }).then(r => r.text());

        const token = data.match(/"dtsg":{"token":"(.*?)"/)[1];

        cachedDtsg.value = token;
        cachedDtsg.expiry = Date.now() + 86400000;

        if (token) return token;
        return false;
    }
    catch {}
}

async function request(url, cookie, method = 'GET', requestData) {
    let headers = {
        ...commonInstagramHeaders,
        'x-ig-www-claim': cookie?._wwwClaim || '0',
        'x-csrftoken': cookie?.values()?.csrftoken,
        cookie
    }
    if (method === 'POST') {
        headers['content-type'] = 'application/x-www-form-urlencoded';
    }

    const data = await fetch(url, {
        method,
        headers,
        body: requestData && new URLSearchParams(requestData),
    });

    if (data.headers.get('X-Ig-Set-Www-Claim') && cookie)
        cookie._wwwClaim = data.headers.get('X-Ig-Set-Www-Claim');

    updateCookie(cookie, data.headers);
    return data.json();
}

async function getPost(id) {
    let data;
    try {
        const cookie = getCookie('instagram');
        let dtsgId;

        if (cookie) {
            dtsgId = await findDtsgId(cookie);
        }

        const url = new URL('https://www.instagram.com/graphql/query/');

        const requestData = {
            jazoest: '26297',
            variables: JSON.stringify({
              shortcode: id,
              __relay_internal__pv__PolarisShareMenurelayprovider: false
            }),
            doc_id: '24852649951017035'
        };
        if (dtsgId) {
            requestData.fb_dtsg = dtsgId;
        }

        data = (await request(url, cookie, 'POST', requestData)).data;
    } catch {}

    if (!data) return { error: 'ErrorCouldntFetch' };

    const sidecar = data?.xdt_shortcode_media?.edge_sidecar_to_children;
    if (sidecar) {
        const picker = sidecar.edges.filter(e => e.node?.display_url)
            .map(e => {
                const type = e.node?.is_video ? "video" : "photo";
                const url = type === "video" ? e.node?.video_url : e.node?.display_url;

                return {
                    type, url,
                    /* thumbnails have `Cross-Origin-Resource-Policy`
                    ** set to `same-origin`, so we need to proxy them */
                    thumb: createStream({
                        service: "instagram",
                        type: "default",
                        u: e.node?.display_url,
                        filename: "image.jpg"
                    })
                }
            });

        if (picker.length) return { picker }
    } else if (data?.xdt_shortcode_media?.video_url) {
        return {
            urls: data.xdt_shortcode_media.video_url,
            filename: `instagram_${id}.mp4`,
            audioFilename: `instagram_${id}_audio`
        }
    } else if (data?.xdt_shortcode_media?.display_url) {
        return {
            urls: data.xdt_shortcode_media.display_url,
            isPhoto: true
        }
    }

    return { error: 'ErrorEmptyDownload' }
}

async function usernameToId(username, cookie) {
    const url = new URL('https://www.instagram.com/api/v1/users/web_profile_info/');
        url.searchParams.set('username', username);

    try {
        const data = await request(url, cookie);
        return data?.data?.user?.id;
    } catch {}
}

async function getStory(username, id) {
    const cookie = getCookie('instagram');
    if (!cookie) return { error: 'ErrorUnsupported' }

    const userId = await usernameToId(username, cookie);
    if (!userId) return { error: 'ErrorEmptyDownload' }

    const url = new URL('https://www.instagram.com/api/v1/feed/reels_media/');
          url.searchParams.set('reel_ids', userId);
          url.searchParams.set('media_id', id);

    let media;
    try {
        const data = await request(url, cookie);
        media = data?.reels_media?.find(m => m.id === userId);
    } catch {}

    const item = media.items[media.media_ids.indexOf(id)];
    if (!item) return { error: 'ErrorEmptyDownload' };
    
    if (item.video_versions) {
        const video = item.video_versions.reduce((a, b) => a.width * a.height < b.width * b.height ? b : a)
        return {
            urls: video.url,
            filename: `instagram_${id}.mp4`,
            audioFilename: `instagram_${id}_audio`
        }
    }

    if (item.image_versions2?.candidates) {
        return {
            urls: item.image_versions2.candidates[0].url,
            isPhoto: true
        }
    }

    return { error: 'ErrorCouldntFetch' };
}

export default function(obj) {
    const { postId, storyId, username } = obj;
    if (postId) return getPost(postId);
    if (username && storyId) return getStory(username, storyId);

    return { error: 'ErrorUnsupported' }
}
