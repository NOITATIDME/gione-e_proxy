// server/server.js
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const {
    WEATHER_API_HUB_URL,
    WEATHER_API_HUB_KEY,
    DAILY_WEATHER_TA_API_HUB_URL,
    DAILY_WEATHER_FCST_API_HUB_URL,
    KAKAO_API_URL,
    KAKAO_ADDRESS_API_URL,
    KAKAO_API_KEY
} = process.env;

// 캐시 (5분간 유지)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(params) {
    return JSON.stringify(params);
}

function getCache(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data;
    }
    return null;
}

function setCache(key, data) {
    cache.set(key, { data, timestamp: Date.now() });
}

// 공통 fetch 함수 (타임아웃)
async function fetchWithTimeout(url, timeout = 5000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

// 좌표 → 주소 변환 API (신규 추가) ---
app.get("/api/kakao/coord2address", async (req, res) => {
    try {
        const { x, y } = req.query;

        if (!x || !y) {
            return res.status(400).json({
                error: "x, y 좌표가 필요합니다",
                address: "현재위치"
            });
        }

        // 캐시 확인
        const cacheKey = getCacheKey({ type: 'coord2address', x, y });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            console.log('좌표→주소 캐시 히트:', x, y);
            return res.json(cachedData);
        }

        if (!KAKAO_API_KEY) {
            console.error('KAKAO_API_KEY가 설정되지 않았습니다!');
            return res.status(500).json({
                error: "카카오 API 키가 설정되지 않았습니다",
                address: "현재위치"
            });
        }

        const apiUrl = `${KAKAO_ADDRESS_API_URL}?x=${x}&y=${y}`;
        //https://dapi.kakao.com/v2/local/geo/coord2address.json
        const response = await fetch(apiUrl, {
            headers: {
                Authorization: `KakaoAK ${KAKAO_API_KEY}`,
                'Content-Type': 'application/json'
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('카카오 좌표→주소 API 오류:', response.status, errorText);
            return res.status(response.status).json({
                error: `카카오 API 오류 (${response.status})`,
                address: "현재위치"
            });
        }

        const data = await response.json();

        if (data.documents && data.documents.length > 0) {
            const addr = data.documents[0].address;
            const address = `${addr.region_1depth_name} ${addr.region_2depth_name} ${addr.region_3depth_name}`;

            const result = { address };
            setCache(cacheKey, result);
            return res.json(result);
        }

        res.json({ address: "현재위치" });
    } catch (error) {
        console.error("좌표→주소 변환 오류:", error.message);
        res.status(500).json({
            error: "좌표→주소 변환 실패",
            details: error.message,
            address: "현재위치"
        });
    }
});

// --- 카카오 주소 검색 API ---
app.get("/api/kakao/search", async (req, res) => {
    try {
        const { query } = req.query;

        if (!query || query.trim().length < 1) {
            return res.json({ documents: [] });
        }

        const cacheKey = getCacheKey({ type: "kakao-search-sigudong", query });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        if (!KAKAO_API_KEY) {
            return res.status(500).json({
                error: "KAKAO_API_KEY not set",
                documents: []
            });
        }

        const apiUrl = `${KAKAO_API_URL}?query=${encodeURIComponent(query)}&size=15`;

        const response = await fetch(apiUrl, {
            headers: {
                Authorization: `KakaoAK ${KAKAO_API_KEY}`
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("카카오 API 오류:", errorText);
            return res.status(response.status).json({ documents: [] });
        }

        const data = await response.json();

        if (!data.documents) {
            return res.json({ documents: [] });
        }

        /**
         * ✅ 시 / 구 / 동만 추출
         */
        const addressSet = new Set();

        data.documents.forEach((doc) => {
            const addr = doc.address;
            if (!addr) return;

            const sido = addr.region_1depth_name;
            const sigungu = addr.region_2depth_name;
            const dong = addr.region_3depth_name;

            if (sido && sigungu && dong) {
                addressSet.add(`${sido} ${sigungu} ${dong}`);
            }
        });

        /**
         * ✅ 가나다순 정렬
         */
        const documents = Array.from(addressSet)
            .sort((a, b) => a.localeCompare(b, "ko"))
            .map((address) => ({ address }));

        const result = { documents };
        setCache(cacheKey, result);
        res.json(result);

    } catch (error) {
        console.error("카카오 검색 오류:", error.message);
        res.status(500).json({
            error: "카카오 검색 실패",
            documents: []
        });
    }
});


// --- 단기예보 (허브 API만) ---
app.get("/api/weather/short", async (req, res) => {
    try {
        const { baseDate, baseTime, nx, ny } = req.query;
        const numOfRows = req.query.numOfRows || 1500;

        const cacheKey = getCacheKey({ baseDate, baseTime, nx, ny, numOfRows });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const url = `${WEATHER_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&numOfRows=${numOfRows}&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

        const response = await fetchWithTimeout(url, 5000);
        const json = await response.json();

        setCache(cacheKey, json);
        res.json(json);
    } catch (error) {
        console.error("단기예보 오류:", error.message);
        res.status(500).json({ error: "단기예보 호출 실패" });
    }
});

// --- 중기예보 기온 (허브 API만) ---
app.get("/api/weather/mid/ta", async (req, res) => {
    try {
        const { regId, tmFc } = req.query;

        const cacheKey = getCacheKey({ type: "mid-ta", regId, tmFc });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const url = `${DAILY_WEATHER_TA_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;

        const response = await fetchWithTimeout(url, 5000);
        const json = await response.json();

        setCache(cacheKey, json);
        res.json(json);
    } catch (error) {
        console.error("중기기온 오류:", error.message);
        res.status(500).json({ error: "중기기온 호출 실패" });
    }
});

// --- 중기예보 육상 (허브 API만) ---
app.get("/api/weather/mid/land", async (req, res) => {
    try {
        const { regId, tmFc } = req.query;

        const cacheKey = getCacheKey({ type: "mid-land", regId, tmFc });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const url = `${DAILY_WEATHER_FCST_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;

        const response = await fetchWithTimeout(url, 5000);
        const json = await response.json();

        setCache(cacheKey, json);
        res.json(json);
    } catch (error) {
        console.error("중기육상 오류:", error.message);
        res.status(500).json({ error: "중기육상 호출 실패" });
    }
});

// --- 배치 요청 ---
app.post("/api/weather/batch", async (req, res) => {
    try {
        const { requests } = req.body;

        const promises = requests.map(async (request) => {
            const { type, params } = request;
            const cacheKey = getCacheKey({ type, ...params });
            const cachedData = getCache(cacheKey);

            if (cachedData) {
                return { type, data: cachedData, cached: true };
            }

            let url;

            if (type === 'short') {
                const { baseDate, baseTime, nx, ny, numOfRows = 1500 } = params;
                url = `${WEATHER_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&numOfRows=${numOfRows}&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
            } else if (type === 'mid-ta') {
                const { regId, tmFc } = params;
                url = `${DAILY_WEATHER_TA_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;
            } else if (type === 'mid-land') {
                const { regId, tmFc } = params;
                url = `${DAILY_WEATHER_FCST_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;
            }

            const response = await fetchWithTimeout(url, 5000);
            const data = await response.json();

            setCache(cacheKey, data);
            return { type, data, cached: false };
        });

        const results = await Promise.all(promises);
        res.json({ results });
    } catch (error) {
        console.error("배치 요청 오류:", error.message);
        res.status(500).json({ error: "배치 요청 실패" });
    }
});

// 캐시 정리 (10분마다)
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            cache.delete(key);
        }
    }
    console.log(`캐시 정리 (현재 ${cache.size}개)`);
}, 10 * 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Weather Proxy Server running on port ${PORT}`));