const fs = require('fs');

const htmlPath = 'C:\\\\Users\\\\saksh\\\\OneDrive\\\\Desktop\\\\logi-safe\\\\public\\\\index.html';
let html = fs.readFileSync(htmlPath, 'utf8');

const startStr = '<div class="space-y-4">';
const endStr = '<!-- Conflict Warning -->';

let startIndex = html.indexOf('<!-- Slot Request Info -->');
if (startIndex !== -1) {
    // walk backwards to find the `<div class="space-y-4">`
    startIndex = html.lastIndexOf(startStr, startIndex);
}

const endIndex = html.indexOf(endStr);

if (startIndex === -1 || endIndex === -1) {
    console.error("Markers not found");
    console.error({startIndex, endIndex});
    process.exit(1);
}

const replacement = `<div class="space-y-4">
                            <!-- Slot Request Info -->
                            <div class="p-3 rounded-md mb-4 flex items-start gap-3" style="background:rgba(122,140,62,0.06);border:1px solid rgba(122,140,62,0.15);">
                                <p class="text-xs text-[#627132] leading-relaxed"><strong>Note:</strong> Slot requests are forwarded to the Admin, who will assign the nearest driver and send them a temporary tracking link.</p>
                            </div>
                            
                            <div class="grid md:grid-cols-2 gap-8">
                                <!-- Column 1: Material and Time -->
                                <div class="space-y-4 flex flex-col justify-between">
                                    <div>
                                        <label class="ui-label block mb-2">Construction Material</label>
                                        <select id="bm-material" class="modal-input w-full">
                                            <option value="Concrete (Ready Mix)">Concrete (Ready Mix)</option>
                                            <option value="Aggregates (Sand/Gravel)">Aggregates (Sand/Gravel)</option>
                                            <option value="Rebar / Steel Force">Rebar / Steel Force</option>
                                            <option value="Brick / Hollow Blocks">Brick / Hollow Blocks</option>
                                            <option value="Cement Bags">Cement Bags</option>
                                            <option value="Excavated Soil / Debris">Excavated Soil / Debris</option>
                                            <option value="Other Construction Item">Other Construction Item</option>
                                        </select>
                                    </div>
                                    <div class="grid grid-cols-2 gap-4 mt-auto pt-4">
                                        <div>
                                            <label class="ui-label block mb-2">Date</label>
                                            <input type="date" id="bm-date" class="modal-input w-full">
                                        </div>
                                        <div>
                                            <label class="ui-label block mb-2">Time Slot</label>
                                            <select id="bm-time" class="modal-input w-full">
                                                <option value="07:00">07:00 AM</option>
                                                <option value="08:00">08:00 AM</option>
                                                <option value="09:00">09:00 AM</option>
                                                <option value="10:00">10:00 AM</option>
                                                <option value="11:00">11:00 AM</option>
                                                <option value="12:00">12:00 PM</option>
                                                <option value="13:00">01:00 PM</option>
                                                <option value="14:00">02:00 PM</option>
                                                <option value="15:00">03:00 PM</option>
                                                <option value="16:00">04:00 PM</option>
                                                <option value="17:00">05:00 PM</option>
                                            </select>
                                        </div>
                                    </div>
                                </div>

                                <!-- Column 2: Location -->
                                <div class="space-y-4">
                                    <div>
                                        <label class="ui-label block mb-2">Location Mode</label>
                                        <div class="grid grid-cols-2 gap-2 mb-4">
                                            <button id="mode-site" class="location-mode-btn" data-mode="site" type="button" style="padding:0.625rem;border-radius:8px;border:1px solid #7A8C3E;background:rgba(122,140,62,0.06);color:#1C1C1C;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;">Standard Site</button>
                                            <button id="mode-custom" class="location-mode-btn" data-mode="custom" type="button" style="padding:0.625rem;border-radius:8px;border:1px solid rgba(28,28,28,0.1);background:transparent;color:#64748B;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;">Custom Point</button>
                                        </div>
                                        <input type="hidden" id="bm-location-mode" value="site">
                                    </div>

                                    <div id="site-selector-container">
                                        <label class="ui-label block mb-2">Construction Site</label>
                                        <select id="bm-site" class="modal-input w-full"></select>
                                    </div>

                                    <div id="custom-location-container" class="hidden space-y-3">
                                        <div>
                                            <label class="ui-label block mb-2">Manual Delivery Address</label>
                                            <textarea id="bm-address" class="modal-input w-full resize-none" style="height:3rem;" placeholder="e.g. Near Hiranandani Estate, Main Gate..."></textarea>
                                        </div>
                                        <button id="bm-pin-btn" class="w-full" type="button" style="padding:0.5rem;border-radius:8px;border:1px dashed rgba(28,28,28,0.2);background:none;color:#64748B;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:0.5rem;transition:all 0.2s;">
                                            <svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                                            <span>Pin Location on Map</span>
                                        </button>
                                        <div id="bm-mini-map" class="hidden" style="height:9rem;border-radius:8px;background:#F7F8F5;overflow:hidden;border:1px solid rgba(28,28,28,0.08);"></div>
                                        <div id="bm-pin-status" class="hidden flex items-center justify-between" style="font-size:10px;color:#7A8C3E;background:rgba(122,140,62,0.04);padding:0.5rem;border-radius:6px;border:1px solid rgba(122,140,62,0.1);">
                                            <div class="flex items-center gap-1">
                                                <span style="flex-shrink:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center;background:rgba(122,140,62,0.15);border-radius:50%;font-size:8px;">✓</span>
                                                <span>Location Pinned:</span>
                                            </div>
                                            <span id="bm-pin-coords" style="font-family:monospace;margin-left:auto;"></span>
                                        </div>
                                    </div>
                                    <input type="hidden" id="bm-lat" value="">
                                    <input type="hidden" id="bm-lng" value="">
                                </div>
                            </div>
                        </div>
                        
                        <!-- Conflict Warning -->`;

let newHtml = html.substring(0, startIndex) + replacement + html.substring(endIndex + endStr.length);
fs.writeFileSync(htmlPath, newHtml, 'utf8');
console.log('Successfully completed html fix via script 2');
