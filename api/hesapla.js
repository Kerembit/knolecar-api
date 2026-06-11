const axios = require("axios");

const GOOGLE_API_KEY = "AIzaSyAZnbRgtRPV0fXaeyvVjNI_v3g81-CzDEI";
const MI_PER_KM      = 0.621371;

const VEHICLES = {
  "mercedes-e-class": {
    label: "Mercedes E-Class", minimumFare: 17, pickupFare: 7.5,
    perMin: 0.95, perMile: 1.55, schedulingCharge: 12, hourlyBase: 80, nightSurcharge: 0.20,
  },
  "mercedes-vito": {
    label: "Mercedes Vito", minimumFare: 55, pickupFare: 18,
    perMin: 1.40, perMile: 2.20, schedulingCharge: 20, hourlyBase: 100, nightSurcharge: 0.20,
  },
  "range-rover": {
    label: "Range Rover", minimumFare: 65, pickupFare: 15,
    perMin: 1.90, perMile: 3.10, schedulingCharge: 24, hourlyBase: 120, nightSurcharge: 0.20,
  },
  "mercedes-s-class": {
    label: "Mercedes S-Class", minimumFare: 28, pickupFare: 12,
    perMin: 1.45, perMile: 2.25, schedulingCharge: 18.0, hourlyBase: 100, nightSurcharge: 0.20,
  },
};

const AIRPORT_REGEX = /heathrow|gatwick|stansted|luton|london city|lhr|lgw|stn|ltn|lcy/i;

function isNight(saatStr = "") {
  const h = parseInt(saatStr.split(":")[0], 10);
  return !isNaN(h) && (h >= 22 || h < 6);
}

function calcOneWay({ vKey, distanceKm, durationMin, night, airportPickup }) {
  const v     = VEHICLES[vKey];
  const miles = distanceKm * MI_PER_KM;
  let price   = v.pickupFare + (miles * v.perMile) + (durationMin * v.perMin) + v.schedulingCharge;
  if (airportPickup) price += 8;
  if (night) price *= (1 + v.nightSurcharge);
  price = Math.max(price, v.minimumFare);
  return Math.ceil(price);
}

function calcHourly({ vKey, hours, night }) {
  const v   = VEHICLES[vKey];
  let price = v.hourlyBase * hours;
  if (night) price *= (1 + v.nightSurcharge);
  return Math.ceil(price);
}

const FIXED_ROUTES = [
  {
    match: (from, to) => from.includes("fareham street") && to.includes("luton"),
    prices: { "mercedes-e-class": 120, "mercedes-vito": 165, "range-rover": 195, "mercedes-s-class": 150 },
    detay: "Fixed Route",
  },
];

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { nereden = "", nereye = "", tip, sure, saat = "", tarih = "" } = req.body;
  const fromLower = nereden.toLowerCase().trim();
  const toLower   = nereye.toLowerCase().trim();
  const night     = isNight(saat);

  console.log("İstek geldi:", req.body);

  // 1. Saatlik kiralama
  if (tip === "By the hour") {
    const hours  = Math.min(Math.max(parseInt(sure) || 3, 3), 24);
    const prices = {};
    for (const key of Object.keys(VEHICLES)) {
      prices[key] = calcHourly({ vKey: key, hours, night });
    }
    return res.status(200).json({
      basarili: true, tip: "hourly", sure: hours, gece: night, prices,
      detay: `${hours}-hour hire${night ? " · night rate +20%" : ""}`,
    });
  }

  // 2. Sabit rota
  const fixed = FIXED_ROUTES.find(r => r.match(fromLower, toLower));
  if (fixed) {
    return res.status(200).json({ basarili: true, tip: "fixed", prices: fixed.prices, detay: fixed.detay });
  }

  // 3. Tek yön — Google Distance Matrix + trafik
  try {
    // Kullanıcının tarih/saatini 1 gün sonrasına al (trafik verisi için)
    let departureTimestamp;
    try {
      const today = new Date().toISOString().split("T")[0];
      const [year, month, day] = (tarih || today).split("-").map(Number);
      const [hour, minute]     = (saat  || "12:00").split(":").map(Number);
      const tripDate = new Date(year, month - 1, day, hour, minute, 0);
      tripDate.setDate(tripDate.getDate() + 1);
      departureTimestamp = Math.floor(tripDate.getTime() / 1000);
    } catch {
      departureTimestamp = Math.floor(Date.now() / 1000) + 86400;
    }

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json`
      + `?origins=${encodeURIComponent(nereden)}`
      + `&destinations=${encodeURIComponent(nereye)}`
      + `&departure_time=${departureTimestamp}`
      + `&traffic_model=best_guess`
      + `&key=${GOOGLE_API_KEY}`;

    const response = await axios.get(url);
    const element  = response.data.rows[0].elements[0];

    if (element.status !== "OK") {
      console.log("Google Hatası:", element.status);
      return res.status(200).json({ basarili: false, hata: `Route error: ${element.status}` });
    }

    const distanceKm   = element.distance.value / 1000;
    const durationMin  = (element.duration_in_traffic?.value ?? element.duration.value) / 60;
    const airportPick  = AIRPORT_REGEX.test(nereden);
    const miles        = (distanceKm * MI_PER_KM).toFixed(1);
    const trafficDelay = element.duration_in_traffic
      ? Math.round((element.duration_in_traffic.value - element.duration.value) / 60) : 0;

    console.log(`Mesafe: ${distanceKm.toFixed(1)}km | Trafikli: ${Math.round(durationMin)}dk | Gecikme: +${trafficDelay}dk`);

    const prices = {};
    for (const key of Object.keys(VEHICLES)) {
      prices[key] = calcOneWay({ vKey: key, distanceKm, durationMin, night, airportPickup: airportPick });
    }

    return res.status(200).json({
      basarili: true, tip: "oneway",
      km: parseFloat(distanceKm.toFixed(1)),
      miles: parseFloat(miles),
      durationMin: Math.round(durationMin),
      gece: night, havalimanı: airportPick, prices,
      detay: `${miles} mi · ${Math.round(durationMin)} min`
           + (trafficDelay > 0 ? ` · +${trafficDelay}min traffic` : "")
           + (night            ? " · night rate +20%"             : "")
           + (airportPick      ? " · airport fee +£8"             : ""),
    });

  } catch (err) {
    console.error("Sunucu Hatası:", err.message);
    return res.status(500).json({ basarili: false, hata: "Calculation server error." });
  }
};
