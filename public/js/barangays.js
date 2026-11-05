// Barangays of Legazpi City and Daraga, Albay, plus the address checks. Shared by
// the browser (address forms) and the server (validation), so both use the same rules.
(function (root) {
    const BARANGAYS = {
        "Legazpi City": [
            "Arimbay", "Bagacay", "Bagong Abre", "Bagumbayan", "Bañadero", "Banquerohan", "Baño", "Bariis",
            "Bigaa", "Binanuahan East", "Binanuahan West", "Bitano", "Bogtong", "Bonga", "Bonot", "Buenavista",
            "Buragwis", "Buyuan", "Cabagñan", "Cabagñan East", "Cabagñan West", "Cabugao", "Cagbacong",
            "Centro-Baybay", "Cruzada", "Dap-dap", "Dinagaan", "Dita", "EM's Barrio", "EM's Barrio East",
            "EM's Barrio South", "Estanza", "Gogon", "Homapon", "Ilawod", "Ilawod East", "Ilawod West",
            "Imalnod", "Imperial Court Subdivision", "Kapantawan", "Kawit-East Washington Drive", "Lamba",
            "Lapu-Lapu", "Mabinit", "Maoyod", "Mariawa", "Maslog", "Matanag", "Oro Site-Magallanes Street",
            "Padang", "Pawa", "Pigcale", "Pinaric", "PNR-Peñaranda Street-Iraya", "Puro", "Rawis", "Rizal Street",
            "Rizal Street-Ilawod", "Sabang", "Sagmin", "Sagpon", "San Francisco", "San Joaquin", "San Roque",
            "Tamaoyan", "Taysan", "Tinago", "Tula-Tula", "Victory Village North", "Victory Village South"
        ],
        "Daraga": [
            "Alcala", "Alobo", "Anislag", "Bagumbayan", "Balinad", "Bañadero", "Bañag", "Bascaran", "Bigao",
            "Binitayan", "Bongalon", "Budiao", "Burgos", "Busay", "Canarom", "Cullat", "Dela Paz", "Dinoronan",
            "Gabawan", "Gapo", "Ibaugan", "Ilawod Area Poblacion", "Inarado", "Kidaco", "Kilicao", "Kimantong",
            "Kinawitan", "Kiwalo", "Lacag", "Mabini", "Malabog", "Malobago", "Maopi", "Market Area Poblacion",
            "Maroroy", "Matnog", "Mayon", "Mi-isi", "Nabasan", "Namantao", "Pandan", "Peñafrancia", "Sagpon",
            "Salvacion", "San Rafael", "San Ramon", "San Roque", "San Vicente Grande", "San Vicente Pequeño",
            "Sipi", "Tabon-tabon", "Tagas", "Talahib", "Villahermosa"
        ]
    };
    const isKnownBarangay = (city, barangay) => (BARANGAYS[city] || []).includes(String(barangay || "").trim());
    // Exact list spelling for a typed barangay ("rawis" → "Rawis"), or "" when it is not in the list.
    const matchBarangay = (city, typed) => {
        const wanted = String(typed || "").trim().toLowerCase();
        return (BARANGAYS[city] || []).find(name => name.toLowerCase() === wanted) || "";
    };

    // Random key presses ("ssdfyugih") instead of a real name: a long word with
    // no vowel, five consonants in a row, or one letter three times in a row.
    function looksRandom(text) {
        return String(text).toLowerCase().split(/[^a-zñ]+/).some(word => word.length >= 5 &&
            (!/[aeiou]/.test(word) || /[^aeiou]{5}/.test(word) || /(.)\1\1/.test(word)));
    }
    const letterCount = text => (String(text).match(/[A-Za-zÑñ]/g) || []).length;

    // Checks zone, street, house/lot number, and landmark. Returns "" when they
    // look like a real address, otherwise a message saying what to fix.
    function checkAddressParts({ zone = "", street = "", house_number = "", landmark = "" }) {
        zone = String(zone).trim(); street = String(street).trim();
        house_number = String(house_number).trim(); landmark = String(landmark).trim();
        if (zone && !(/^\d{1,2}$/.test(zone) && Number(zone) >= 1)) return "Zone must be a number from 1 to 99, for example 5.";
        if (!street || street.length > 60 || !/^[A-Za-zÑñ0-9 .,'#-]+$/.test(street) || letterCount(street) < 3 || looksRandom(street))
            return "Enter the actual street name, for example Rizal Street.";
        if (!house_number || house_number.length > 30 || !/\d/.test(house_number) || !/^[A-Za-zÑñ0-9 .,#/-]+$/.test(house_number) || looksRandom(house_number))
            return "Enter the actual house or lot number, for example 123, 12-A, or Lot 5 Block 3.";
        if (landmark && (landmark.length > 80 || !/^[A-Za-zÑñ0-9 .,'#&()/-]+$/.test(landmark) || letterCount(landmark) < 3 || looksRandom(landmark)))
            return "Enter a real landmark, for example Near Bitano Elementary School.";
        return "";
    }

    // A person's name: 2–80 characters, letters (including Ñ and accents), spaces, and . ' -
    function checkFullName(name) {
        name = String(name ?? "").trim().replace(/\s+/g, " ");
        if (name.length < 2 || name.length > 80 || !/^[\p{L} .'-]+$/u.test(name) || letterCount(name) < 2)
            return "Enter the full name using letters only (2 to 80 characters), for example Juan Dela Cruz.";
        return "";
    }

    if (typeof module !== "undefined" && module.exports) {
        module.exports = { BARANGAYS, isKnownBarangay, matchBarangay, checkAddressParts, checkFullName };
        return;
    }

    // Fill a barangay <select> with the barangays of the chosen city and refill
    // it whenever the city changes. A saved value is re-selected when present.
    function fill(select, city, value) {
        const names = BARANGAYS[city] || [];
        select.innerHTML = "";
        const placeholder = new Option(city ? "Choose barangay" : "Choose city first", "");
        placeholder.disabled = true;
        select.append(placeholder);
        names.forEach(name => select.append(new Option(name, name)));
        select.value = names.includes(value) ? value : "";
    }
    function bind(citySelect, barangaySelect) {
        if (!citySelect || !barangaySelect) return null;
        fill(barangaySelect, citySelect.value, barangaySelect.value);
        citySelect.addEventListener("change", () => fill(barangaySelect, citySelect.value, ""));
        return {
            // Use this instead of setting .value directly, so the list matches the city first.
            set(city, barangay) { citySelect.value = city; fill(barangaySelect, citySelect.value, barangay); }
        };
    }
    root.OLVBarangays = { BARANGAYS, isKnownBarangay, matchBarangay, checkAddressParts, checkFullName, bind };
})(this);
