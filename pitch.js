/**
 * Питч-детектор (YIN) + перевод частоты в ноту/центы.
 * Работает в браузере и в Node (для test_pitch.js).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PitchKit = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var NOTE_NAMES_EN = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
  ];
  var NOTE_NAMES_RU = [
    "До", "До#", "Ре", "Ре#", "Ми", "Фа", "Фа#", "Соль", "Соль#", "Ля", "Ля#", "Си",
  ];

  var A4_HZ = 440;
  var A4_MIDI = 69;

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  /** Частота → MIDI (дробный). */
  function frequencyToMidi(hz) {
    if (!(hz > 0)) return NaN;
    return A4_MIDI + 12 * Math.log2(hz / A4_HZ);
  }

  /** MIDI → частота. */
  function midiToFrequency(midi) {
    return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
  }

  /** Имя ноты и октава из MIDI. */
  function midiToNote(midi, lang) {
    if (!isFinite(midi)) return null;
    var rounded = Math.round(midi);
    var pc = ((rounded % 12) + 12) % 12;
    var octave = Math.floor(rounded / 12) - 1;
    var names = lang === "ru" ? NOTE_NAMES_RU : NOTE_NAMES_EN;
    return {
      midi: rounded,
      name: names[pc],
      nameEn: NOTE_NAMES_EN[pc],
      octave: octave,
      label: names[pc] + octave,
      labelEn: NOTE_NAMES_EN[pc] + octave,
    };
  }

  /** Отклонение от ближайшей ноты в центах (−50…+50). */
  function centsFromNearest(midi) {
    if (!isFinite(midi)) return NaN;
    return (midi - Math.round(midi)) * 100;
  }

  /**
   * YIN: оценка фундаментальной частоты.
   * @param {Float32Array|number[]} buffer — временной сигнал
   * @param {number} sampleRate
   * @param {{threshold?: number, minHz?: number, maxHz?: number}} [opts]
   * @returns {{frequency: number, probability: number}|null}
   */
  function detectPitchYIN(buffer, sampleRate, opts) {
    opts = opts || {};
    var threshold = opts.threshold != null ? opts.threshold : 0.15;
    var minHz = opts.minHz != null ? opts.minHz : 70;
    var maxHz = opts.maxHz != null ? opts.maxHz : 1000;

    var size = buffer.length;
    if (size < 4 || !(sampleRate > 0)) return null;

    var tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
    var tauMax = Math.min(Math.floor(size / 2) - 1, Math.floor(sampleRate / minHz));
    if (tauMax <= tauMin) return null;

    // RMS: тишина → нет питча
    var rms = 0;
    for (var i = 0; i < size; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / size);
    if (rms < 0.01) return null;

    var yinBuffer = new Float32Array(tauMax + 1);

    // 1) Разностная функция
    yinBuffer[0] = 1;
    for (var tau = 1; tau <= tauMax; tau++) {
      var sum = 0;
      for (var j = 0; j < tauMax; j++) {
        var delta = buffer[j] - buffer[j + tau];
        sum += delta * delta;
      }
      yinBuffer[tau] = sum;
    }

    // 2) Cumulative mean normalized difference
    var runningSum = 0;
    yinBuffer[0] = 1;
    for (tau = 1; tau <= tauMax; tau++) {
      runningSum += yinBuffer[tau];
      yinBuffer[tau] = runningSum > 0 ? (yinBuffer[tau] * tau) / runningSum : 1;
    }

    // 3) Absolute threshold
    var tauEstimate = -1;
    for (tau = tauMin; tau < tauMax; tau++) {
      if (yinBuffer[tau] < threshold) {
        while (tau + 1 < tauMax && yinBuffer[tau + 1] < yinBuffer[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate < 0) {
      // fallback: глобальный минимум в диапазоне
      var minVal = Infinity;
      for (tau = tauMin; tau <= tauMax; tau++) {
        if (yinBuffer[tau] < minVal) {
          minVal = yinBuffer[tau];
          tauEstimate = tau;
        }
      }
      if (!(minVal < 0.5)) return null;
    }

    // 4) Параболическая интерполяция
    var betterTau = tauEstimate;
    if (tauEstimate > 0 && tauEstimate < tauMax) {
      var s0 = yinBuffer[tauEstimate - 1];
      var s1 = yinBuffer[tauEstimate];
      var s2 = yinBuffer[tauEstimate + 1];
      var denom = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(denom) > 1e-12) {
        betterTau = tauEstimate + (s2 - s0) / denom;
      }
    }

    if (!(betterTau > 0)) return null;
    var frequency = sampleRate / betterTau;
    if (frequency < minHz || frequency > maxHz) return null;

    var probability = 1 - yinBuffer[tauEstimate];
    return { frequency: frequency, probability: clamp(probability, 0, 1) };
  }

  /**
   * Полный разбор питча: Гц → нота + центы.
   */
  function analyzePitch(buffer, sampleRate, opts) {
    var result = detectPitchYIN(buffer, sampleRate, opts);
    if (!result) return null;
    var midi = frequencyToMidi(result.frequency);
    var note = midiToNote(midi, (opts && opts.lang) || "ru");
    var cents = centsFromNearest(midi);
    return {
      frequency: result.frequency,
      probability: result.probability,
      midi: midi,
      note: note,
      cents: cents,
      inTune: Math.abs(cents) <= 25,
    };
  }

  /** Синтетический синус для тестов. */
  function synthesizeSine(frequency, sampleRate, length, amplitude) {
    amplitude = amplitude == null ? 0.5 : amplitude;
    var buf = new Float32Array(length);
    var phase = 0;
    var step = (2 * Math.PI * frequency) / sampleRate;
    for (var i = 0; i < length; i++) {
      buf[i] = Math.sin(phase) * amplitude;
      phase += step;
      if (phase > Math.PI * 2) phase -= Math.PI * 2;
    }
    return buf;
  }

  /** MIDI ноты C-мажорной гаммы начиная с midiRoot (обычно C4 = 60). */
  function cMajorScaleMidis(rootMidi, upThenDown) {
    var steps = [0, 2, 4, 5, 7, 9, 11, 12];
    var up = steps.map(function (s) {
      return rootMidi + s;
    });
    if (!upThenDown) return up;
    var down = up.slice(0, -1).reverse();
    return up.concat(down);
  }

  var INTERVALS = [
    { semitones: 2, name: "Большая секунда" },
    { semitones: 3, name: "Малая терция" },
    { semitones: 4, name: "Большая терция" },
    { semitones: 5, name: "Чистая кварта" },
    { semitones: 7, name: "Чистая квинта" },
    { semitones: 9, name: "Большая секста" },
    { semitones: 12, name: "Октава" },
  ];

  return {
    A4_HZ: A4_HZ,
    NOTE_NAMES_RU: NOTE_NAMES_RU,
    NOTE_NAMES_EN: NOTE_NAMES_EN,
    INTERVALS: INTERVALS,
    frequencyToMidi: frequencyToMidi,
    midiToFrequency: midiToFrequency,
    midiToNote: midiToNote,
    centsFromNearest: centsFromNearest,
    detectPitchYIN: detectPitchYIN,
    analyzePitch: analyzePitch,
    synthesizeSine: synthesizeSine,
    cMajorScaleMidis: cMajorScaleMidis,
  };
});
