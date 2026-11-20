// Pixel classifier for the labels layer. Runs off the UI thread; every
// manually annotated pixel is used in every training epoch (no sampling).
/* global self */
(function () {
    'use strict';
    var PATCH = 11;   // 11x11 intensity patch around the pixel
    var INPUT = PATCH * PATCH;
    var HIDDEN = 24;
    var EPOCHS = 60;
    var BATCH = 128;

    function createModel(classes) {
        var w1 = new Float32Array(INPUT * HIDDEN);
        var w2 = new Float32Array(HIDDEN * classes.length);
        for (var i = 0; i < w1.length; i++) w1[i] = (Math.random() * 2 - 1) * Math.sqrt(2 / INPUT);
        for (var j = 0; j < w2.length; j++) w2[j] = (Math.random() * 2 - 1) * Math.sqrt(2 / HIDDEN);
        return { classes: classes, w1: w1, w2: w2, b1: new Float32Array(HIDDEN),
                 b2: new Float32Array(classes.length) };
    }

    function forward(model, x, hidden, probs) {
        var i, h, c, sum, largest = -Infinity, total = 0;
        for (h = 0; h < HIDDEN; h++) {
            sum = model.b1[h];
            for (i = 0; i < INPUT; i++) sum += model.w1[h * INPUT + i] * x[i];
            hidden[h] = Math.max(0, sum);
        }
        for (c = 0; c < model.classes.length; c++) {
            sum = model.b2[c];
            for (h = 0; h < HIDDEN; h++) sum += model.w2[c * HIDDEN + h] * hidden[h];
            probs[c] = sum;
            largest = Math.max(largest, sum);
        }
        for (c = 0; c < model.classes.length; c++) {
            probs[c] = Math.exp(probs[c] - largest);
            total += probs[c];
        }
        for (c = 0; c < model.classes.length; c++) probs[c] /= total;
    }

    function train(features, targets, classes) {
        var model = createModel(classes);
        var n = targets.length;
        var x = new Float32Array(INPUT);
        var hidden = new Float32Array(HIDDEN);
        var probs = new Float32Array(classes.length);
        var gw1 = new Float32Array(model.w1.length), gw2 = new Float32Array(model.w2.length);
        var gb1 = new Float32Array(HIDDEN), gb2 = new Float32Array(classes.length);
        var moment = [model.w1, model.b1, model.w2, model.b2].map(function (a) {
            return { m: new Float32Array(a.length), v: new Float32Array(a.length) };
        });
        var step = 0, loss = 0;
        // Cross-entropy of the best constant predictor (predicting the class
        // frequencies): the baseline the convergence guard compares against.
        var counts = new Array(classes.length);
        var ci, t;
        for (ci = 0; ci < classes.length; ci++) counts[ci] = 0;
        for (t = 0; t < n; t++) counts[classes.indexOf(targets[t])]++;
        var baseline = 0;
        for (ci = 0; ci < classes.length; ci++) {
            if (counts[ci] > 0) baseline -= (counts[ci] / n) * Math.log(counts[ci] / n);
        }
        // Strokes arrive grouped by painted region (background first, then each
        // foreground label), so fixed-order mini-batches are class-pure and
        // their opposite gradients cancel through Adam: the loss stays at the
        // random-guess baseline and argmax collapses to one class everywhere.
        // Shuffle the sample order, reshuffled every epoch.
        var order = new Array(n);
        for (var oi = 0; oi < n; oi++) order[oi] = oi;
        function update(weights, gradients, state, batch) {
            for (var k = 0; k < weights.length; k++) {
                var g = gradients[k] / batch;
                state.m[k] = 0.9 * state.m[k] + 0.1 * g;
                state.v[k] = 0.999 * state.v[k] + 0.001 * g * g;
                weights[k] -= 0.01 * (state.m[k] / (1 - Math.pow(0.9, step))) /
                    (Math.sqrt(state.v[k] / (1 - Math.pow(0.999, step))) + 1e-8);
            }
            gradients.fill(0);
        }
        for (var epoch = 0; epoch < EPOCHS; epoch++) {
            for (var sh = n - 1; sh > 0; sh--) {
                var r = Math.floor(Math.random() * (sh + 1));
                var swap = order[sh]; order[sh] = order[r]; order[r] = swap;
            }
            loss = 0;
            for (var s = 0; s < n; s++) {
                var sample = order[s];
                x.set(features.subarray(sample * INPUT, (sample + 1) * INPUT));
                forward(model, x, hidden, probs);
                var target = classes.indexOf(targets[sample]);
                loss -= Math.log(Math.max(probs[target], 1e-12));
                for (var c = 0; c < classes.length; c++) {
                    var delta = probs[c] - (c === target ? 1 : 0);
                    gb2[c] += delta;
                    for (var h = 0; h < HIDDEN; h++) gw2[c * HIDDEN + h] += delta * hidden[h];
                }
                for (var j = 0; j < HIDDEN; j++) {
                    if (hidden[j] <= 0) continue;
                    var dh = 0;
                    for (var o = 0; o < classes.length; o++) {
                        dh += (probs[o] - (o === target ? 1 : 0)) * model.w2[o * HIDDEN + j];
                    }
                    gb1[j] += dh;
                    for (var a = 0; a < INPUT; a++) gw1[j * INPUT + a] += dh * x[a];
                }
                var batch = (s % BATCH) + 1;
                if (batch === BATCH || s === n - 1) {
                    step++;
                    update(model.w1, gw1, moment[0], batch);
                    update(model.b1, gb1, moment[1], batch);
                    update(model.w2, gw2, moment[2], batch);
                    update(model.b2, gb2, moment[3], batch);
                }
            }
            if (epoch % 5 === 4 || epoch === EPOCHS - 1) {
                self.postMessage({ progress: epoch + 1, total: EPOCHS });
            }
        }
        for (var w = 0; w < model.w1.length; w++) {
            if (!isFinite(model.w1[w])) break;
        }
        if (!isFinite(loss / n) || w < model.w1.length) {
            throw new Error('Training diverged (non-finite weights) — repaint strokes with ' +
                            'clearer foreground/background contrast and try again.');
        }
        if (baseline > 0 && loss / n > baseline * 0.95) {
            throw new Error('Training did not converge (loss ' + (loss / n).toFixed(3) +
                            ', random-guess baseline ' + baseline.toFixed(3) + ') — Train again; ' +
                            'if it repeats, repaint strokes with clearer foreground/background contrast.');
        }
        return { model: model, loss: loss / n, count: n };
    }

    // The image tile includes a two-pixel halo. `ox`/`oy` are its world-space
    // origin, so a prediction at the edge of one tile sees the same patch as
    // the neighboring tile and as training on that pixel. Position features
    // are intentionally absent: with strokes localized in a few spots they let
    // the model memorize stroke locations and predict background everywhere.
    function featuresAt(data, width, height, ox, oy, x, y, min, max, out) {
        var k = 0, span = (max - min) || 1;
        var half = (PATCH - 1) / 2;
        for (var dy = -half; dy <= half; dy++) {
            for (var dx = -half; dx <= half; dx++) {
                var px = Math.max(0, Math.min(width - 1, x + dx - ox));
                var py = Math.max(0, Math.min(height - 1, y + dy - oy));
                out[k++] = (data[py * width + px] - min) / span;
            }
        }
    }

    function predict(message) {
        var model = message.model;
        var arrays = { Uint8Array: Uint8Array, Uint16Array: Uint16Array,
                       Uint32Array: Uint32Array, Int16Array: Int16Array,
                       Float32Array: Float32Array, Float64Array: Float64Array };
        if (!arrays[message.arrayType]) throw new Error('Unsupported image pixel type');
        var data = new arrays[message.arrayType](message.raw);
        var values = new Uint16Array(message.values);
        var manual = new Uint8Array(message.manual);
        var x = new Float32Array(INPUT);
        var hidden = new Float32Array(HIDDEN);
        var probs = new Float32Array(model.classes.length);
        var count = 0;
        var foreground = 0;
        for (var yy = 0; yy < message.tileHeight; yy++) {
            for (var xx = 0; xx < message.tileWidth; xx++) {
                var i = yy * 256 + xx;
                if (manual[i]) continue;
                var wx = message.tx * 256 + xx;
                var wy = message.ty * 256 + yy;
                featuresAt(data, message.width, message.height, message.ox, message.oy,
                           wx, wy, message.range.min, message.range.max, x);
                forward(model, x, hidden, probs);
                var best = 0;
                for (var c = 1; c < probs.length; c++) {
                    if (probs[c] > probs[best]) best = c;
                }
                values[i] = model.classes[best];
                count++;
                if (values[i] !== 0) foreground++;
            }
        }
        return { values: values.buffer, count: count, foreground: foreground };
    }

    self.onmessage = function (event) {
        try {
            var message = event.data;
            if (message.type === 'train') {
                var result = train(new Float32Array(message.features), new Uint16Array(message.targets), message.classes);
                self.postMessage({ result: result });
            } else if (message.type === 'predict') {
                var predicted = predict(message);
                self.postMessage({ result: predicted }, [predicted.values]);
            }
        } catch (err) {
            self.postMessage({ error: err.message });
        }
    };
})();
