/* parks.js — real ballparks: dimensions, looks and park factors, for the stadium picker and the 3D builder (stadium3d.js).
 *
 * fence: control points [angle from dead centre in degrees (-45 = left-field line, 0 = centre, +45 = right-field line), distance from home plate in metres].
 * Taiwan figures come from each stadium's Chinese Wikipedia article, Koshien from the Japanese one; MLB and the other NPB figures are the commonly published
 * dimensions and may be a foot or a metre off. pf = home-run park factor (1.00 = average), a rough multi-year estimate, not an official number.
 *
 * roof: open | dome (fully enclosed) | retract (retractable, shown open) | canopy (partial roof over the stands)
 * wall: ads (padded wall with adverts) | plain | ivy | monster | brick       back: city | hills | mountains | palms | bay | none
 */
const PARKS = (function () {
    const P = {}, ORDER = [];
    const FT = 0.3048;
    const mk = (l, lc, c, rc, r) => [[-45, l], [-22.5, lc], [0, c], [22.5, rc], [45, r]];
    const ft = (l, lc, c, rc, r) => mk(l, lc, c, rc, r).map(([a, d]) => [a, Math.round(d * FT * 10) / 10]);
    const add = (id, o) => { P[id] = Object.assign({ id, roof: 'open', turf: 'grass', dirt: 'red', wall: 'ads', wallCol: '#0f3a24', wh: 3.0, back: 'city', pf: 1.0, region: 'MLB', deco: [] }, o); ORDER.push(id); };

    // ───────── Taiwan ─────────
    add('taipei_dome', { region: 'TW', zh: '台北大巨蛋', en: 'Taipei Dome', city: '台北', cap: 40000, fence: mk(102.1, 112, 121.9, 112, 102.1), wh: 3.5, roof: 'dome', roofCol: '#d7dadf', turf: 'turf', wallCol: '#13264a', back: 'none', pf: 1.0, note: '固定式淡灰鈦金屬屋頂，人工草皮' });
    add('tianmu', { region: 'TW', zh: '天母棒球場', en: 'Tianmu Baseball Stadium', city: '台北', cap: 10000, fence: mk(99, 108, 120, 108, 99), turf: 'turf', wallCol: '#123a2a', back: 'hills', pf: 1.1, note: '外野沒有固定座椅，人工草皮（2020 年鋪設）' });
    add('taichung', { region: 'TW', zh: '台中洲際棒球場', en: 'Taichung Intercontinental', city: '台中', cap: 19321, fence: mk(99.1, 110, 121.9, 110, 99.1), wallCol: '#0d2f5c', back: 'city', pf: 1.0, note: '天然草，外野有大型螢幕' });
    add('tainan', { region: 'TW', zh: '台南棒球場', en: 'Tainan Baseball Stadium', city: '台南', cap: 12000, fence: mk(103.3, 111, 120, 111, 103.3), wallCol: '#18424a', back: 'city', pf: 1.0, note: '天然草' });
    add('xinzhuang', { region: 'TW', zh: '新莊棒球場', en: 'Xinzhuang Baseball Stadium', city: '新北', cap: 12150, fence: mk(99.1, 110, 121.9, 110, 99.1), wallCol: '#0f3a24', back: 'city', pf: 1.05, note: '天然草與人工草混合' });
    add('taoyuan', { region: 'TW', zh: '桃園國際棒球場', en: 'Taoyuan International', city: '桃園', cap: 18000, fence: mk(100.6, 111, 121.9, 111, 100.6), wallCol: '#5a1424', back: 'city', pf: 1.0, note: '天然草，外野大螢幕' });
    add('chengcing', { region: 'TW', zh: '澄清湖棒球場', en: 'Chengching Lake', city: '高雄', cap: 20000, fence: mk(100, 111, 121.9, 111, 100), wallCol: '#0f3a24', back: 'hills', pf: 1.02, note: '天然草與紅土' });

    // ───────── Japan ─────────
    add('tokyo_dome', { region: 'JP', zh: '東京巨蛋', en: 'Tokyo Dome', city: '東京', cap: 46000, fence: mk(100, 111, 122, 111, 100), wh: 3.6, roof: 'dome', roofCol: '#f4f4f0', turf: 'turf', dirt: 'black', wallCol: '#10331f', back: 'none', pf: 1.07, note: '氣膜式白色屋頂，人工草皮' });
    add('koshien', { region: 'JP', zh: '阪神甲子園球場', en: 'Hanshin Koshien', city: '西宮', cap: 47359, fence: mk(95, 118, 118, 118, 95), wh: 3.0, roof: 'canopy', roofCol: '#c9ced6', turf: 'grass', dirt: 'black', wall: 'plain', wallCol: '#143d27', back: 'hills', ivy: true, pf: 0.85, note: '銀傘、黑土、天然草（內野幾乎全是土）' });
    add('jingu', { region: 'JP', zh: '明治神宮野球場', en: 'Meiji Jingu Stadium', city: '東京', cap: 30969, fence: mk(97.5, 112, 120, 112, 97.5), turf: 'turf', dirt: 'black', wallCol: '#143d27', back: 'city', pf: 1.1, note: '人工草皮，近市區綠地' });
    add('yokohama', { region: 'JP', zh: '橫濱球場', en: 'Yokohama Stadium', city: '橫濱', cap: 35250, fence: mk(94.2, 108, 117.7, 108, 94.2), turf: 'turf', dirt: 'black', wallCol: '#0e2c66', back: 'city', pf: 1.15, note: '人工草皮，左右外野偏近' });
    add('mazda', { region: 'JP', zh: '馬自達球場（廣島）', en: 'Mazda Zoom-Zoom Stadium', city: '廣島', cap: 33000, fence: mk(101, 112, 122, 112, 100), dirt: 'red', wallCol: '#8a0f1d', back: 'hills', pf: 0.98, note: '天然草，內野有紅土' });
    add('vantelin', { region: 'JP', zh: '萬事達巨蛋名古屋', en: 'Vantelin Dome Nagoya', city: '名古屋', cap: 36778, fence: mk(100, 111, 122, 111, 100), wh: 4.8, roof: 'dome', roofCol: '#e9ecef', turf: 'turf', dirt: 'black', wallCol: '#0e2c66', back: 'none', pf: 0.85, note: '固定式屋頂，場地寬廣，全壘打較難' });
    add('paypay', { region: 'JP', zh: 'PayPay 巨蛋（福岡）', en: 'Mizuho PayPay Dome', city: '福岡', cap: 40122, fence: mk(100, 111, 122, 111, 100), roof: 'retract', roofCol: '#e6e8ec', turf: 'turf', dirt: 'black', wallCol: '#202020', back: 'bay', pf: 1.1, note: '開閉式屋頂，有全壘打露臺' });
    add('kyocera', { region: 'JP', zh: '京瓷巨蛋大阪', en: 'Kyocera Dome Osaka', city: '大阪', cap: 36220, fence: mk(100, 111, 122, 111, 100), roof: 'dome', roofCol: '#e2e6ea', turf: 'turf', dirt: 'black', wallCol: '#0b1f3d', back: 'none', pf: 0.85, note: '固定式屋頂，場地寬廣' });
    add('zozo', { region: 'JP', zh: 'ZOZO 海洋球場', en: 'ZOZO Marine Stadium', city: '千葉', cap: 29635, fence: mk(99.5, 111, 122, 111, 99.5), turf: 'turf', dirt: 'black', wallCol: '#101418', back: 'bay', pf: 1.0, note: '海邊球場，風大' });
    add('belluna', { region: 'JP', zh: 'Belluna 巨蛋（西武）', en: 'Belluna Dome', city: '所澤', cap: 33556, fence: mk(100, 111, 122, 111, 100), roof: 'canopy', roofCol: '#e8eaee', turf: 'turf', dirt: 'black', wallCol: '#0a2a5c', back: 'hills', roofFull: true, pf: 1.0, note: '屋頂加上外圍開放，通風' });
    add('rakuten_mobile', { region: 'JP', zh: '樂天 Mobile Park 宮城', en: 'Rakuten Mobile Park Miyagi', city: '仙台', cap: 31220, fence: mk(100.1, 111, 122, 111, 100.1), wallCol: '#7a0f20', back: 'hills', pf: 1.0, note: '天然草，有摩天輪' });
    add('escon', { region: 'JP', zh: '北海道 ES CON 球場', en: 'Es Con Field Hokkaido', city: '北廣島', cap: 36000, fence: mk(97.6, 110, 121, 110, 99.1), roof: 'retract', roofCol: '#dfe4ea', dirt: 'red', wallCol: '#0e2c4a', back: 'hills', pf: 1.0, note: '開閉式屋頂，天然草，左右不對稱（北海道日本火腿主場）' });

    // ───────── MLB ─────────
    const mlb = (id, zh, en, city, cap, fence, o) => { o = Object.assign({ region: 'US', zh, en, city, cap, fence: ft.apply(null, fence) }, o); if (o.fenceExtra) o.fenceExtra = o.fenceExtra.map(([a, d]) => [a, Math.round(d * FT * 10) / 10]); add(id, o); };
    mlb('dodger', '道奇球場', 'Dodger Stadium', '洛杉磯', 56000, [330, 375, 395, 375, 330], { wallCol: '#0e2a5c', back: 'palms', pf: 1.05, note: '背後有山丘與棕櫚樹，落日時分特別美' });
    mlb('yankee', '洋基球場', 'Yankee Stadium', '紐約', 46537, [318, 399, 408, 385, 314], { wallCol: '#0c2340', back: 'city', pf: 1.13, note: '右外野偏近，全壘打大國' });
    mlb('fenway', '芬威球場', 'Fenway Park', '波士頓', 37755, [310, 379, 390, 380, 302], { fenceExtra: [[12, 420]], wall: 'monster', wallCol: '#1f5a30', wh: 3.0, whSeg: [[-45, -18, 11.3]], back: 'city', pf: 0.96, note: '左外野 11.3 公尺綠色巨牆（Green Monster），右外野最深 420 呎' });
    mlb('rogers', '羅渣士中心', 'Rogers Centre', '多倫多', 39150, [328, 375, 400, 375, 328], { roof: 'retract', turf: 'turf', wallCol: '#0b2a6b', back: 'city', pf: 1.05, note: '開閉式屋頂，人工草皮' });
    mlb('camden', '金鶯公園', 'Oriole Park at Camden Yards', '巴爾的摩', 42455, [333, 364, 410, 373, 318], { wallCol: '#1a2a40', whSeg: [[18, 45, 7.0]], deco: ['warehouse'], back: 'city', pf: 1.0, note: '右外野後方有磚造倉庫' });
    mlb('tropicana', '熱帶風情球場', 'Tropicana Field', '聖彼得堡', 25000, [315, 370, 404, 370, 322], { roof: 'dome', roofCol: '#cfd4da', turf: 'turf', wallCol: '#0a2a5a', back: 'none', pf: 0.92, note: '固定式圓錐屋頂，人工草皮' });
    mlb('progressive', '前進球場', 'Progressive Field', '克里夫蘭', 34820, [325, 370, 410, 375, 325], { wallCol: '#0c2340', back: 'city', pf: 0.98, note: '' });
    mlb('comerica', '康美利卡公園', 'Comerica Park', '底特律', 41083, [345, 370, 412, 365, 330], { wallCol: '#0c2340', back: 'city', pf: 0.92, note: '外野寬大，三壘打多' });
    mlb('kauffman', '考夫曼球場', 'Kauffman Stadium', '堪薩斯市', 37903, [330, 387, 410, 387, 330], { wallCol: '#0b3c6e', back: 'hills', pf: 0.88, note: '左右對稱，外野寬闊' });
    mlb('target', '標靶球場', 'Target Field', '明尼阿波利斯', 38544, [339, 377, 404, 367, 328], { wallCol: '#0c2340', back: 'city', pf: 1.0, note: '' });
    mlb('ratefield', 'Rate Field', 'Rate Field', '芝加哥', 40615, [330, 375, 400, 375, 335], { wallCol: '#111111', back: 'city', pf: 1.1, note: '白襪主場，全壘打較多' });
    mlb('daikin', '大金公園（休士頓）', 'Daikin Park', '休士頓', 41168, [315, 362, 409, 373, 326], { roof: 'retract', wallCol: '#00205b', back: 'city', pf: 1.03, note: '開閉式屋頂，左外野偏近' });
    mlb('sutter', '薩特健康公園', 'Sutter Health Park', '西沙加緬度', 13416, [330, 378, 403, 372, 325], { wallCol: '#003831', back: 'hills', pf: 1.0, note: '運動家暫時主場，小型球場' });
    mlb('tmobile', 'T-Mobile Park', 'T-Mobile Park', '西雅圖', 47929, [331, 378, 401, 381, 326], { roof: 'retract', wallCol: '#0c2c56', back: 'mountains', pf: 0.97, note: '開閉式屋頂（遮雨傘形），遠方有群山' });
    mlb('globelife', '環球人壽球場', 'Globe Life Field', '阿靈頓', 40300, [329, 372, 407, 374, 326], { roof: 'retract', turf: 'turf', wallCol: '#003278', back: 'none', pf: 1.0, note: '開閉式屋頂，空調，人工草皮' });
    mlb('angel', '天使球場', 'Angel Stadium', '安那翰', 45517, [347, 390, 396, 370, 350], { wallCol: '#003263', back: 'hills', pf: 1.04, note: '' });
    mlb('citi', '花旗球場', 'Citi Field', '紐約', 41922, [335, 379, 408, 398, 330], { wallCol: '#002d72', back: 'city', pf: 0.97, note: '' });
    mlb('citizens', '公民銀行公園', 'Citizens Bank Park', '費城', 42901, [329, 374, 401, 369, 330], { wallCol: '#003a70', back: 'city', pf: 1.1, note: '' });
    mlb('truist', 'Truist Park', 'Truist Park', '亞特蘭大', 41084, [335, 385, 400, 375, 325], { wallCol: '#13274f', back: 'city', pf: 1.02, note: '' });
    mlb('loandepot', 'loanDepot park', 'loanDepot park', '邁阿密', 36742, [344, 386, 407, 392, 335], { roof: 'retract', turf: 'turf', wallCol: '#00a3e0', back: 'city', pf: 0.85, note: '開閉式屋頂，場地寬大，全壘打困難' });
    mlb('nationals', '國民球場', 'Nationals Park', '華盛頓', 41373, [336, 377, 402, 370, 335], { wallCol: '#14225a', back: 'city', pf: 1.0, note: '' });
    mlb('wrigley', '瑞格利球場', 'Wrigley Field', '芝加哥', 41649, [355, 368, 400, 368, 353], { wall: 'ivy', wallCol: '#2a5a2a', wh: 3.4, back: 'city', pf: 1.0, note: '百年球場，爬藤外野牆，風向影響全壘打' });
    mlb('amfam', '美國家庭球場', 'American Family Field', '密爾瓦基', 41900, [344, 371, 400, 374, 345], { roof: 'retract', wallCol: '#12284b', back: 'none', pf: 1.07, note: '開閉式屋頂' });
    mlb('busch', '布希球場', 'Busch Stadium', '聖路易', 44383, [336, 375, 400, 375, 335], { wallCol: '#c41e3a', back: 'city', pf: 0.88, note: '背後是拱門與市景' });
    mlb('gabp', '大美國球場', 'Great American Ball Park', '辛辛那提', 43500, [328, 379, 404, 370, 325], { wallCol: '#c6011f', back: 'bay', pf: 1.18, note: '俄亥俄河畔，全壘打最多的球場之一' });
    mlb('pnc', 'PNC 公園', 'PNC Park', '匹茲堡', 38747, [325, 389, 399, 375, 320], { wallCol: '#27251f', whSeg: [[30, 45, 6.4]], back: 'city', pf: 0.85, note: '背後是河與橋、市景，右外野牆高' });
    mlb('petco', '佩科公園', 'Petco Park', '聖地牙哥', 39860, [336, 390, 396, 391, 322], { wallCol: '#2f241d', back: 'city', pf: 0.92, note: '' });
    mlb('oracle', '甲骨文公園', 'Oracle Park', '舊金山', 41331, [339, 364, 391, 421, 309], { wallCol: '#27251f', whSeg: [[8, 45, 7.6]], back: 'bay', pf: 0.8, note: '右外野 7.6 公尺高牆，牆外是海灣；右中外野 421 呎「三壘打巷」' });
    mlb('chase', '大通球場', 'Chase Field', '鳳凰城', 48330, [330, 374, 407, 374, 334], { roof: 'retract', turf: 'turf', wallCol: '#30263e', back: 'none', pf: 1.04, note: '開閉式屋頂，人工草皮' });
    mlb('coors', '庫爾斯球場', 'Coors Field', '丹佛', 46897, [347, 390, 415, 375, 350], { wallCol: '#33006f', back: 'mountains', pf: 1.15, note: '海拔 1,600 公尺，空氣稀薄，球飛得遠' });

    const home = {   // 'league:name' -> park id (default home park)
        'MLB:Dodgers': 'dodger', 'MLB:Yankees': 'yankee', 'MLB:Red Sox': 'fenway', 'MLB:Blue Jays': 'rogers', 'MLB:Orioles': 'camden', 'MLB:Rays': 'tropicana',
        'MLB:Guardians': 'progressive', 'MLB:Tigers': 'comerica', 'MLB:Royals': 'kauffman', 'MLB:Twins': 'target', 'MLB:White Sox': 'ratefield', 'MLB:Astros': 'daikin',
        'MLB:Athletics': 'sutter', 'MLB:Mariners': 'tmobile', 'MLB:Rangers': 'globelife', 'MLB:Angels': 'angel', 'MLB:Mets': 'citi', 'MLB:Phillies': 'citizens',
        'MLB:Braves': 'truist', 'MLB:Marlins': 'loandepot', 'MLB:Nationals': 'nationals', 'MLB:Cubs': 'wrigley', 'MLB:Brewers': 'amfam', 'MLB:Cardinals': 'busch',
        'MLB:Reds': 'gabp', 'MLB:Pirates': 'pnc', 'MLB:Padres': 'petco', 'MLB:Giants': 'oracle', 'MLB:Diamondbacks': 'chase', 'MLB:Rockies': 'coors',
        'CPBL:Brothers': 'taichung', 'CPBL:Lions': 'tainan', 'CPBL:Monkeys': 'taoyuan', 'CPBL:Guardians': 'xinzhuang', 'CPBL:Dragons': 'tianmu', 'CPBL:Hawks': 'chengcing', 'CPBL:CPBL Legends': 'taipei_dome',
        'NPB:Giants': 'tokyo_dome', 'NPB:Tigers': 'koshien', 'NPB:Dragons': 'vantelin', 'NPB:Carp': 'mazda', 'NPB:Swallows': 'jingu', 'NPB:BayStars': 'yokohama',
        'NPB:Hawks': 'paypay', 'NPB:Fighters': 'escon', 'NPB:Buffaloes': 'kyocera', 'NPB:Marines': 'zozo', 'NPB:Lions': 'belluna', 'NPB:Eagles': 'rakuten_mobile',
        'WBC:Chinese Taipei': 'taipei_dome', 'WBC:Japan': 'tokyo_dome', 'WBC:South Korea': 'tokyo_dome', 'WBC:Australia': 'tokyo_dome',
        'WBC:USA': 'loandepot', 'WBC:Dominican Rep.': 'loandepot', 'WBC:Puerto Rico': 'loandepot', 'WBC:Mexico': 'loandepot', 'WBC:Italy': 'loandepot'
    };
    const GROUPS = [['TW', '台灣'], ['JP', '日本'], ['US', '美國']];
    return {
        all: P, order: ORDER, groups: GROUPS, DEFAULT: 'dodger',
        get(id) { return P[id] || P[this.DEFAULT]; },
        homeOf(team) { return (team && home[team.lg + ':' + team.name]) || this.DEFAULT; },
        inGroup(g) { return ORDER.filter(id => P[id].region === g); },
        ftOf(m) { return Math.round(m / FT); }
    };
})();
