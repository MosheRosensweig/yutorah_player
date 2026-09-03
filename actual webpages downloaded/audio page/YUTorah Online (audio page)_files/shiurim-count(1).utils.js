async function fetchTotalShiurim(totalShiurimCount = 0) {
    if (totalShiurimCount) {
        setTotalShiurimWithExpiry(totalShiurimCount);
        return totalShiurimCount.toLocaleString();
    }

    // fetch session value and evaluate
    const totalShiurim = JSON.parse(sessionStorage.getItem('totalShiurim'));
    if (totalShiurim && new Date(totalShiurim.expirationDate) > Date.now() && false) {
        return totalShiurim.count.toLocaleString();
    } else {
        const isLocalhost = window.location.href.includes('localhost');
        const url = 'https://api.yutorah.org/homepage/shiurimCount'; // isLocalhost ? 'https://localhost:7074/homepage/shiurimCount' : 'https://api4.yutorah.org/homepage/shiurimCount';

        const result = await fetch(url);
        const shiurimCount = await result.json();

        setTotalShiurimWithExpiry(shiurimCount);
        return shiurimCount.toLocaleString();
    }
}

function setTotalShiurimWithExpiry(shiurimCount) {
    const expirationDate = new Date();
    expirationDate.setDate(expirationDate.getDate() + 1);

    const item = {
        count: shiurimCount,
        expirationDate: expirationDate.getTime()
    };

    sessionStorage.setItem('totalShiurim', JSON.stringify(item));
}