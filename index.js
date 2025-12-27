/*
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const {
    WEATHER_API_URL,
    WEATHER_API_KEY,
    WEATHER_API_HUB_URL,
    WEATHER_API_HUB_KEY,
    DAILY_WEATHER_TA_API_URL,
    DAILY_WEATHER_FCST_API_URL,
    DAILY_WEATHER_API_KEY,
    DAILY_WEATHER_TA_API_HUB_URL,
    DAILY_WEATHER_FCST_API_HUB_URL,
    KAKAO_API_URL,
    KAKAO_API_KEY
} = process.env;

// 캐시 추가 (5분간 유지)
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5분

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

// 공통 fetch 함수 (타임아웃 + 재시도)
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

// 허브 API와 공공 API 동시 요청 (race)
async function fetchWeatherData(hubUrl, publicUrl) {
    try {
        // 두 API를 동시에 요청하되, 먼저 성공하는 쪽 사용
        const result = await Promise.race([
            fetchWithTimeout(hubUrl, 3000).then(async (res) => {
                const json = await res.json();
                if (json.response?.header?.resultCode === "00" || json.response?.body) {
                    return { source: 'hub', data: json };
                }
                throw new Error('Hub API invalid response');
            }),
            fetchWithTimeout(publicUrl, 5000).then(async (res) => {
                const contentType = res.headers.get("content-type");
                if (!contentType?.includes("application/json")) {
                    throw new Error('Not JSON');
                }
                const json = await res.json();
                if (json.response?.header?.resultCode === "00") {
                    return { source: 'public', data: json };
                }
                throw new Error('Public API invalid response');
            })
        ]);

        console.log(`API 성공 (${result.source})`);
        return result.data;
    } catch (error) {
        // 둘 다 실패하면 폴백 시도
        try {
            const response = await fetchWithTimeout(publicUrl, 10000);
            const json = await response.json();
            console.log('폴백 성공');
            return json;
        } catch (fallbackError) {
            console.error('모든 API 실패:', fallbackError.message);
            throw fallbackError;
        }
    }
}

// --- 카카오 주소 검색 API (수정된 버전) ---
app.get("/api/kakao/search", async (req, res) => {
    try {
        const { query } = req.query;

        if (!query || query.trim().length < 2) {
            return res.json({ documents: [] });
        }

        // 캐시 확인
        const cacheKey = getCacheKey({ type: 'kakao-search', query });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            console.log('카카오 검색 캐시 히트:', query);
            return res.json(cachedData);
        }

        // API 키 확인
        if (!KAKAO_API_KEY) {
            console.error('KAKAO_API_KEY가 설정되지 않았습니다!');
            return res.status(500).json({
                error: "카카오 API 키가 설정되지 않았습니다",
                documents: []
            });
        }

        const apiUrl = `${KAKAO_API_URL}?query=${encodeURIComponent(query)}`;
        console.log('카카오 API 요청:', apiUrl);

        const response = await fetch(apiUrl, {
            headers: {
                Authorization: `KakaoAK ${KAKAO_API_KEY}`,
                'Content-Type': 'application/json'
            },
        });

        // 응답 상태 확인
        if (!response.ok) {
            const errorText = await response.text();
            console.error('카카오 API 오류 응답:', response.status, errorText);
            return res.status(response.status).json({
                error: `카카오 API 오류 (${response.status})`,
                details: errorText,
                documents: []
            });
        }

        // Content-Type 확인
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const errorText = await response.text();
            console.error('카카오 API가 JSON이 아닌 응답 반환:', contentType, errorText.substring(0, 200));
            return res.status(500).json({
                error: "카카오 API가 잘못된 응답을 반환했습니다",
                contentType,
                documents: []
            });
        }

        const data = await response.json();
        console.log('카카오 API 응답:', data.documents?.length || 0, '개 결과');

        if (data.documents) {
            // "동/읍/면"으로 끝나는 주소만 필터링
            const filtered = data.documents.filter((doc) => {
                const addressName = doc.address_name || "";
                return /(동|읍|면)$/.test(addressName);
            });

            let finalResults = filtered;

            // 결과가 없으면 "동"을 붙여서 재시도
            if (filtered.length === 0 && query.length >= 2 && !query.endsWith('동')) {
                console.log('결과 없음, "동" 추가하여 재시도:', query + '동');

                const retryUrl = `${KAKAO_API_URL}?query=${encodeURIComponent(query + "동")}`;
                const retryResponse = await fetch(retryUrl, {
                    headers: {
                        Authorization: `KakaoAK ${KAKAO_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                });

                if (retryResponse.ok) {
                    const retryData = await retryResponse.json();

                    if (retryData.documents) {
                        const retryFiltered = retryData.documents.filter((doc) => {
                            const addressName = doc.address_name || "";
                            return /(동|읍|면)$/.test(addressName);
                        });

                        finalResults = retryFiltered;
                        console.log('재시도 결과:', retryFiltered.length, '개');
                    }
                }
            }

            // 중복 제거 (같은 x, y 좌표)
            const uniqueResults = finalResults.reduce((acc, current) => {
                const isDuplicate = acc.find(
                    (item) => item.x === current.x && item.y === current.y
                );
                if (!isDuplicate) {
                    acc.push(current);
                }
                return acc;
            }, []);

            const result = { documents: uniqueResults };
            setCache(cacheKey, result);
            console.log('최종 결과:', uniqueResults.length, '개');
            res.json(result);
        } else {
            res.json({ documents: [] });
        }
    } catch (error) {
        console.error("카카오 검색 오류:", error.message);
        console.error("상세 오류:", error);
        res.status(500).json({
            error: "카카오 검색 호출 실패",
            details: error.message,
            documents: []
        });
    }
});

// --- 단기예보 라우트 ---
app.get("/api/weather/short", async (req, res) => {
    try {
        const { baseDate, baseTime, nx, ny } = req.query;
        const numOfRows = req.query.numOfRows || 1500;

        // 캐시 확인
        const cacheKey = getCacheKey({ baseDate, baseTime, nx, ny, numOfRows });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const hubUrl = `${WEATHER_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&numOfRows=${numOfRows}&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
        const publicUrl = `${WEATHER_API_URL}?serviceKey=${WEATHER_API_KEY}&dataType=JSON&numOfRows=${numOfRows}&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;

        const json = await fetchWeatherData(hubUrl, publicUrl);
        setCache(cacheKey, json);
        res.json(json);
    } catch (error) {
        console.error("단기예보 오류:", error.message);
        res.status(500).json({ error: "단기예보 호출 실패" });
    }
});

// --- 중기예보 라우트 (기온) ---
app.get("/api/weather/mid/ta", async (req, res) => {
    try {
        const { regId, tmFc } = req.query;

        // 캐시 확인
        const cacheKey = getCacheKey({ type: "mid-ta", regId, tmFc });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const hubUrl = `${DAILY_WEATHER_TA_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;
        const publicUrl = `${DAILY_WEATHER_TA_API_URL}?serviceKey=${DAILY_WEATHER_API_KEY}&numOfRows=10&pageNo=1&regId=${regId}&tmFc=${tmFc}&dataType=JSON`;

        const json = await fetchWeatherData(hubUrl, publicUrl);
        setCache(cacheKey, json);
        res.json(json);
    } catch (error) {
        console.error("중기기온 오류:", error.message);
        res.status(500).json({ error: "중기기온 호출 실패" });
    }
});

// --- 중기예보 라우트 (육상) ---
app.get("/api/weather/mid/land", async (req, res) => {
    try {
        const { regId, tmFc } = req.query;

        // 캐시 확인
        const cacheKey = getCacheKey({ type: "mid-land", regId, tmFc });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            return res.json(cachedData);
        }

        const hubUrl = `${DAILY_WEATHER_FCST_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;
        const decodedKey = decodeURIComponent(DAILY_WEATHER_API_KEY);
        const publicUrl = `${DAILY_WEATHER_FCST_API_URL}?serviceKey=${decodedKey}&numOfRows=10&pageNo=1&regId=${regId}&tmFc=${tmFc}&dataType=JSON`;

        const json = await fetchWeatherData(hubUrl, publicUrl);
        setCache(cacheKey, json);
        res.json(json);
    } catch (error) {
        console.error("중기육상 오류:", error.message);
        res.status(500).json({ error: "중기육상 호출 실패" });
    }
});

// 배치 요청 엔드포인트 (클라이언트가 한 번에 여러 데이터 요청)
app.post("/api/weather/batch", async (req, res) => {
    try {
        const { requests } = req.body; // [{ type: 'short', params: {...} }, ...]

        const promises = requests.map(async (request) => {
            const { type, params } = request;
            const cacheKey = getCacheKey({ type, ...params });
            const cachedData = getCache(cacheKey);

            if (cachedData) {
                return { type, data: cachedData, cached: true };
            }

            let hubUrl, publicUrl;

            if (type === 'short') {
                const { baseDate, baseTime, nx, ny, numOfRows = 1500 } = params;
                hubUrl = `${WEATHER_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&numOfRows=${numOfRows}&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
                publicUrl = `${WEATHER_API_URL}?serviceKey=${WEATHER_API_KEY}&dataType=JSON&numOfRows=${numOfRows}&pageNo=1&base_date=${baseDate}&base_time=${baseTime}&nx=${nx}&ny=${ny}`;
            } else if (type === 'mid-ta') {
                const { regId, tmFc } = params;
                hubUrl = `${DAILY_WEATHER_TA_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;
                publicUrl = `${DAILY_WEATHER_TA_API_URL}?serviceKey=${DAILY_WEATHER_API_KEY}&numOfRows=10&pageNo=1&regId=${regId}&tmFc=${tmFc}&dataType=JSON`;
            } else if (type === 'mid-land') {
                const { regId, tmFc } = params;
                hubUrl = `${DAILY_WEATHER_FCST_API_HUB_URL}?authKey=${WEATHER_API_HUB_KEY}&dataType=JSON&regId=${regId}&tmFc=${tmFc}`;
                const decodedKey = decodeURIComponent(DAILY_WEATHER_API_KEY);
                publicUrl = `${DAILY_WEATHER_FCST_API_URL}?serviceKey=${decodedKey}&numOfRows=10&pageNo=1&regId=${regId}&tmFc=${tmFc}&dataType=JSON`;
            }

            const data = await fetchWeatherData(hubUrl, publicUrl);
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
*/
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

        if (!query || query.trim().length < 2) {
            return res.json({ documents: [] });
        }

        // 캐시 확인
        const cacheKey = getCacheKey({ type: 'kakao-search', query });
        const cachedData = getCache(cacheKey);
        if (cachedData) {
            console.log('카카오 검색 캐시 히트:', query);
            return res.json(cachedData);
        }

        if (!KAKAO_API_KEY) {
            console.error('KAKAO_API_KEY가 설정되지 않았습니다!');
            return res.status(500).json({
                error: "카카오 API 키가 설정되지 않았습니다",
                documents: []
            });
        }

        const apiUrl = `${KAKAO_API_URL}?query=${encodeURIComponent(query)}`;

        const response = await fetch(apiUrl, {
            headers: {
                Authorization: `KakaoAK ${KAKAO_API_KEY}`,
                'Content-Type': 'application/json'
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('카카오 API 오류:', response.status, errorText);
            return res.status(response.status).json({
                error: `카카오 API 오류 (${response.status})`,
                documents: []
            });
        }

        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
            const errorText = await response.text();
            console.error('카카오 API JSON 아님:', contentType);
            return res.status(500).json({
                error: "카카오 API가 잘못된 응답을 반환했습니다",
                documents: []
            });
        }

        const data = await response.json();

        if (data.documents) {
            // "동/읍/면"으로 끝나는 주소만 필터링
            const filtered = data.documents.filter((doc) => {
                const addressName = doc.address_name || "";
                return /(동|읍|면)$/.test(addressName);
            });

            let finalResults = filtered;

            // 결과가 없으면 "동"을 붙여서 재시도
            if (filtered.length === 0 && query.length >= 2 && !query.endsWith('동')) {
                const retryUrl = `${KAKAO_API_URL}?query=${encodeURIComponent(query + "동")}`;
                const retryResponse = await fetch(retryUrl, {
                    headers: {
                        Authorization: `KakaoAK ${KAKAO_API_KEY}`,
                        'Content-Type': 'application/json'
                    },
                });

                if (retryResponse.ok) {
                    const retryData = await retryResponse.json();
                    if (retryData.documents) {
                        const retryFiltered = retryData.documents.filter((doc) => {
                            const addressName = doc.address_name || "";
                            return /(동|읍|면)$/.test(addressName);
                        });
                        finalResults = retryFiltered;
                    }
                }
            }

            // 중복 제거
            const uniqueResults = finalResults.reduce((acc, current) => {
                const isDuplicate = acc.find(
                    (item) => item.x === current.x && item.y === current.y
                );
                if (!isDuplicate) {
                    acc.push(current);
                }
                return acc;
            }, []);

            const result = { documents: uniqueResults };
            setCache(cacheKey, result);
            res.json(result);
        } else {
            res.json({ documents: [] });
        }
    } catch (error) {
        console.error("카카오 검색 오류:", error.message);
        res.status(500).json({
            error: "카카오 검색 호출 실패",
            details: error.message,
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