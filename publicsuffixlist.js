/*******************************************************************************

    publicsuffixlist.js - an efficient javascript implementation to deal with
    Mozilla Foundation's Public Suffix List <http://publicsuffix.org/list/>

    Copyright (C) 2013-present Raymond Hill

    License: pick the one which suits you:
      GPL v3 see <https://www.gnu.org/licenses/gpl.html>
      APL v2 see <http://www.apache.org/licenses/LICENSE-2.0>

*/

/*! Home: https://github.com/gorhill/publicsuffixlist.js -- GPLv3 APLv2 */

/* jshint
    browser: true,
    eqeqeq: true,
    esversion: 11,
    laxbreak: true,
    module: true,
    node: true,
    strict: global,
    undef: true
*/

/* globals
    WebAssembly,
    exports: true,
    module
*/

'use strict';

/*******************************************************************************

    Reference:
    https://publicsuffix.org/list/

    Excerpt:

    > Algorithm
    > 
    > 1. Match domain against all rules and take note of the matching ones.
    > 2. If no rules match, the prevailing rule is "*".
    > 3. If more than one rule matches, the prevailing rule is the one which
         is an exception rule.
    > 4. If there is no matching exception rule, the prevailing rule is the
         one with the most labels.
    > 5. If the prevailing rule is a exception rule, modify it by removing
         the leftmost label.
    > 6. The public suffix is the set of labels from the domain which match
         the labels of the prevailing rule, using the matching algorithm above.
    > 7. The registered or registrable domain is the public suffix plus one
         additional label.

*/

/*******************************************************************************

    Tree encoding in array buffer:

     Node:
     +  u8: length of char data
     +  u8: flags => bit 0: is_publicsuffix, bit 1: is_exception
     + u16: length of array of children
     + u32: char data or offset to char data
     + u32: offset to array of children
     = 12 bytes

    More bits in flags could be used; for example:
    - to distinguish private suffixes

*/

                                    // i32 /  i8
const HOSTNAME_SLOT         = 0;    // jshint ignore:line
const LABEL_INDICES_SLOT    = 256;  //  -- / 256 (256/2 => 128 labels max)
const RULES_PTR_SLOT        = 100;  // 100 / 400 (400-256=144 => 144>128)
const SUFFIX_NOT_FOUND_SLOT = 399;  //  -- / 399 (safe, see above)
const CHARDATA_PTR_SLOT     = 101;  // 101 / 404
const EMPTY_STRING          = '';
const SELFIE_MAGIC          = 2;

/******************************************************************************/

class PublicSuffixList {
    constructor() {
        this.version = '3.0';

        this._wasmMemory = null;
        this._pslBuffer32 = null;
        this._pslBuffer8 = null;
        this._pslByteLength = 0;
        this._hostnameArg = EMPTY_STRING;

        this._getPublicSuffixPosWASM = null;
        this._getPublicSuffixPos = this._getPublicSuffixPosJS;

        this._wasmPromise = null;
    }

    /**************************************************************************/

    _allocateBuffers(byteLength) {
        this._pslByteLength = byteLength + 3 & ~3;
        if (
            this._pslBuffer32 !== null &&
            this._pslBuffer32.byteLength >= this._pslByteLength
        ) {
            return;
        }
        if ( this._wasmMemory !== null ) {
            const newPageCount = this._pslByteLength + 0xFFFF >>> 16;
            const curPageCount = this._wasmMemory.buffer.byteLength >>> 16;
            const delta = newPageCount - curPageCount;
            if ( delta > 0 ) {
                this._wasmMemory.grow(delta);
                this._pslBuffer32 = new Uint32Array(this._wasmMemory.buffer);
                this._pslBuffer8 = new Uint8Array(this._wasmMemory.buffer);
            }
        } else {
            this._pslBuffer8 = new Uint8Array(this._pslByteLength);
            this._pslBuffer32 = new Uint32Array(this._pslBuffer8.buffer);
        }
        this._hostnameArg = EMPTY_STRING;
        this._pslBuffer8[LABEL_INDICES_SLOT] = 0;
    }

    /**************************************************************************/

    // Parse and set a UTF-8 text-based suffix list. Format is same as found at:
    // http://publicsuffix.org/list/
    //
    // `toAscii` is a converter from unicode to punycode. Required since the
    // Public Suffix List contains unicode characters.
    // Suggestion: use <https://github.com/bestiejs/punycode.js>

    parse(text, toAscii) {
        // Use short property names for better minifying results
        const rootRule = {
            l: EMPTY_STRING,    // l => label
            f: 0,               // f => flags
            c: null             // c => children
        };

        // Tree building
        {
            const compareLabels = function(a, b) {
                let n = a.length;
                let d = n - b.length;
                if ( d !== 0 ) { return d; }
                for ( let i = 0; i < n; i++ ) {
                    d = a.charCodeAt(i) - b.charCodeAt(i);
                    if ( d !== 0 ) { return d; }
                }
                return 0;
            };

            const addToTree = function(rule, exception) {
                let node = rootRule;
                let end = rule.length;
                while ( end > 0 ) {
                    const beg = rule.lastIndexOf('.', end - 1);
                    const label = rule.slice(beg + 1, end);
                    end = beg;

                    if ( Array.isArray(node.c) === false ) {
                        const child = { l: label, f: 0, c: null };
                        node.c = [ child ];
                        node = child;
                        continue;
                    }

                    let left = 0;
                    let right = node.c.length;
                    while ( left < right ) {
                        const i = left + right >>> 1;
                        const d = compareLabels(label, node.c[i].l);
                        if ( d < 0 ) {
                            right = i;
                            if ( right === left ) {
                                const child = {
                                    l: label,
                                    f: 0,
                                    c: null
                                };
                                node.c.splice(left, 0, child);
                                node = child;
                                break;
                            }
                            continue;
                        }
                        if ( d > 0 ) {
                            left = i + 1;
                            if ( left === right ) {
                                const child = {
                                    l: label,
                                    f: 0,
                                    c: null
                                };
                                node.c.splice(right, 0, child);
                                node = child;
                                break;
                            }
                            continue;
                        }
                        /* d === 0 */
                        node = node.c[i];
                        break;
                    }
                }
                node.f |= 0b01;
                if ( exception ) {
                    node.f |= 0b10;
                }
            };

            // 2. If no rules match, the prevailing rule is "*".
            addToTree('*', false);

            const mustPunycode = /[^*a-z0-9.-]/;
            const textEnd = text.length;
            let lineBeg = 0;

            while ( lineBeg < textEnd ) {
                let lineEnd = text.indexOf('\n', lineBeg);
                if ( lineEnd === -1 ) {
                    lineEnd = text.indexOf('\r', lineBeg);
                    if ( lineEnd === -1 ) {
                        lineEnd = textEnd;
                    }
                }
                let line = text.slice(lineBeg, lineEnd);
                lineBeg = lineEnd + 1;

                // Ignore comments
                const pos = line.indexOf('//');
                if ( pos !== -1 ) {
                    line = line.slice(0, pos);
                }

                // Ignore surrounding whitespaces
                line = line.trim();

                const exception = line.length > 0 && line.charCodeAt(0) === 0x21 /* '!' */;
                if ( exception ) {
                    line = line.slice(1);
                }

                if ( line.length > 0 && mustPunycode.test(line) ) {
                    line = toAscii(line.toLowerCase());
                }

                // https://en.wikipedia.org/wiki/Hostname#Syntax
                if ( line.length === 0 || line.length > 253 ) { continue; }

                addToTree(line, exception);
            }
        }

        {
            const labelToOffsetMap = new Map();
            const treeData = [];
            const charData = [];

            const allocate = function(n) {
                const ibuf = treeData.length;
                for ( let i = 0; i < n; i++ ) {
                    treeData.push(0);
                }
                return ibuf;
            };

            const storeNode = function(ibuf, node) {
                const nChars = node.l.length;
                const nChildren = node.c !== null
                    ? node.c.length
                    : 0;
                treeData[ibuf+0] = nChildren << 16 | node.f << 8 | nChars;
                // char data
                if ( nChars <= 4 ) {
                    let v = 0;
                    if ( nChars > 0 ) {
                        v |= node.l.charCodeAt(0);
                        if ( nChars > 1 ) {
                            v |= node.l.charCodeAt(1) << 8;
                            if ( nChars > 2 ) {
                                v |= node.l.charCodeAt(2) << 16;
                                if ( nChars > 3 ) {
                                    v |= node.l.charCodeAt(3) << 24;
                                }
                            }
                        }
                    }
                    treeData[ibuf+1] = v;
                } else {
                    let offset = labelToOffsetMap.get(node.l);
                    if ( typeof offset === 'undefined' ) {
                        offset = charData.length;
                        for ( let i = 0; i < nChars; i++ ) {
                            charData.push(node.l.charCodeAt(i));
                        }
                        labelToOffsetMap.set(node.l, offset);
                    }
                    treeData[ibuf+1] = offset;
                }
                // child nodes
                if ( Array.isArray(node.c) === false ) {
                    treeData[ibuf+2] = 0;
                    return;
                }

                const iarray = allocate(nChildren * 3);
                treeData[ibuf+2] = iarray;
                for ( let i = 0; i < nChildren; i++ ) {
                    storeNode(iarray + i * 3, node.c[i]);
                }
            };

            // First 512 bytes are reserved for internal use
            allocate(512 >> 2);

            const iRootRule = allocate(3);
            storeNode(iRootRule, rootRule);
            treeData[RULES_PTR_SLOT] = iRootRule;

            const iCharData = treeData.length << 2;
            treeData[CHARDATA_PTR_SLOT] = iCharData;

            const byteLength = (treeData.length << 2) + (charData.length + 3 & ~3);
            this._allocateBuffers(byteLength);
            this._pslBuffer32.set(treeData);
            this._pslBuffer8.set(charData, treeData.length << 2);
        }
    }

    /**************************************************************************/

    _setHostnameArg(hostname) {
        const buf = this._pslBuffer8;
        if ( hostname === this._hostnameArg ) { return buf[LABEL_INDICES_SLOT]; }
        if ( hostname === null || hostname.length === 0 ) {
            this._hostnameArg = EMPTY_STRING;
            return (buf[LABEL_INDICES_SLOT] = 0);
        }
        hostname = hostname.toLowerCase();
        this._hostnameArg = hostname;
        let n = hostname.length;
        if ( n > 255 ) { n = 255; }
        buf[LABEL_INDICES_SLOT] = n;
        let i = n;
        let j = LABEL_INDICES_SLOT + 1;
        while ( i-- ) {
            const c = hostname.charCodeAt(i);
            if ( c === 0x2E /* '.' */ ) {
                buf[j+0] = i + 1;
                buf[j+1] = i;
                j += 2;
            }
            buf[i] = c;
        }
        buf[j] = 0;
        return n;
    }

    /**************************************************************************/

    // Returns an offset to the start of the public suffix.
    //
    // WASM-able, because no information outside the buffer content is required.

    _getPublicSuffixPosJS() {
        const buf8 = this._pslBuffer8;
        const buf32 = this._pslBuffer32;
        const iCharData = buf32[CHARDATA_PTR_SLOT];

        let iNode = this._pslBuffer32[RULES_PTR_SLOT];
        let cursorPos = -1;
        let iLabel = LABEL_INDICES_SLOT;

        // Label-lookup loop
        for (;;) {
            // Extract label indices
            const labelBeg = buf8[iLabel+1];
            const labelLen = buf8[iLabel+0] - labelBeg;
            // Match-lookup loop: binary search
            let r = buf32[iNode+0] >>> 16;
            if ( r === 0 ) { break; }
            const iCandidates = buf32[iNode+2];
            let l = 0;
            let iFound = 0;
            while ( l < r ) {
                const iCandidate = l + r >>> 1;
                const iCandidateNode = iCandidates + iCandidate + (iCandidate << 1);
                const candidateLen = buf32[iCandidateNode+0] & 0x000000FF;
                let d = labelLen - candidateLen;
                if ( d === 0 ) {
                    const iCandidateChar = candidateLen <= 4
                        ? iCandidateNode + 1 << 2
                        : iCharData + buf32[iCandidateNode+1];
                    for ( let i = 0; i < labelLen; i++ ) {
                        d = buf8[labelBeg+i] - buf8[iCandidateChar+i];
                        if ( d !== 0 ) { break; }
                    }
                }
                if ( d < 0 ) {
                    r = iCandidate;
                } else if ( d > 0 ) {
                    l = iCandidate + 1;
                } else /* if ( d === 0 ) */ {
                    iFound = iCandidateNode;
                    break;
                }
            }
            // 2. If no rules match, the prevailing rule is "*".
            if ( iFound === 0 ) {
                if ( buf8[iCandidates + 1 << 2] !== 0x2A /* '*' */ ) { break; }
                buf8[SUFFIX_NOT_FOUND_SLOT] = 1;
                iFound = iCandidates;
            }
            iNode = iFound;
            // 5. If the prevailing rule is a exception rule, modify it by
            //    removing the leftmost label.
            if ( (buf32[iNode+0] & 0x00000200) !== 0 ) {
                if ( iLabel > LABEL_INDICES_SLOT ) {
                    return iLabel - 2;
                }
                break;
            }
            if ( (buf32[iNode+0] & 0x00000100) !== 0 ) {
                cursorPos = iLabel;
            }
            if ( labelBeg === 0 ) { break; }
            iLabel += 2;
        }

        return cursorPos;
    }

    /**************************************************************************/

    getPublicSuffix(hostname) {
        if ( this._pslBuffer32 === null ) { return EMPTY_STRING; }

        const hostnameLen = this._setHostnameArg(hostname);
        const buf8 = this._pslBuffer8;
        if ( hostnameLen === 0 || buf8[0] === 0x2E /* '.' */ ) {
            return EMPTY_STRING;
        }

        const cursorPos = this._getPublicSuffixPos();
        if ( cursorPos === -1 ) {
            return EMPTY_STRING;
        }

        const beg = buf8[cursorPos + 1];
        return beg === 0 ? this._hostnameArg : this._hostnameArg.slice(beg);
    }

    /**************************************************************************/

    getDomain(hostname) {
        if ( this._pslBuffer32 === null ) { return EMPTY_STRING; }

        const hostnameLen = this._setHostnameArg(hostname);
        const buf8 = this._pslBuffer8;
        if ( hostnameLen === 0 || buf8[0] === 0x2E /* '.' */ ) {
            return EMPTY_STRING;
        }

        const cursorPos = this._getPublicSuffixPos();
        if ( cursorPos === -1 || buf8[cursorPos + 1] === 0 ) {
            return EMPTY_STRING;
        }

        // 7. The registered or registrable domain is the public suffix plus one
        //    additional label.
        const beg = buf8[cursorPos + 3];
        return beg === 0 ? this._hostnameArg : this._hostnameArg.slice(beg);
    }

    /**************************************************************************/

    suffixInPSL(hostname) {
        if ( this._pslBuffer32 === null ) { return false; }

        const hostnameLen = this._setHostnameArg(hostname);
        const buf8 = this._pslBuffer8;
        if ( hostnameLen === 0 || buf8[0] === 0x2E /* '.' */ ) {
            return false;
        }

        buf8[SUFFIX_NOT_FOUND_SLOT] = 0;
        const cursorPos = this._getPublicSuffixPos();
        return cursorPos !== -1 &&
               buf8[cursorPos + 1] === 0 &&
               buf8[SUFFIX_NOT_FOUND_SLOT] !== 1;
    }

    /**************************************************************************/

    toSelfie(encoder = null) {
        if ( this._pslBuffer8 === null ) { return ''; }
        if ( encoder !== null ) {
            const bufferStr = encoder.encode(this._pslBuffer8.buffer, this._pslByteLength);
            return `${SELFIE_MAGIC}\t${bufferStr}`;
        }
        return {
            magic: SELFIE_MAGIC,
            buf32: Array.from(
                new Uint32Array(this._pslBuffer8.buffer, 0, this._pslByteLength >>> 2)
            ),
        };
    }

    fromSelfie(selfie, decoder = null) {
        let byteLength = 0;
        if (
            typeof selfie === 'string' &&
            selfie.length !== 0 &&
            decoder !== null
        ) {
            const pos = selfie.indexOf('\t');
            if ( pos === -1 || selfie.slice(0, pos) !== `${SELFIE_MAGIC}` ) {
                return false;
            }
            const bufferStr = selfie.slice(pos + 1);
            byteLength = decoder.decodeSize(bufferStr);
            if ( byteLength === 0 ) { return false; }
            this._allocateBuffers(byteLength);
            decoder.decode(bufferStr, this._pslBuffer8.buffer);
        } else if (
            selfie.magic === SELFIE_MAGIC &&
            Array.isArray(selfie.buf32)
        ) {
            byteLength = selfie.buf32.length << 2;
            this._allocateBuffers(byteLength);
            this._pslBuffer32.set(selfie.buf32);
        } else {
            return false;
        }

        // Important!
        this._hostnameArg = EMPTY_STRING;
        this._pslBuffer8[LABEL_INDICES_SLOT] = 0;

        return true;
    }

    /**************************************************************************/

    // The WASM module is entirely optional, the JS implementation will be
    // used should the WASM module be unavailable for whatever reason.

    async enableWASM({ customFetch = null } = {}) {
        const wasmModuleFetcher = async ({ customFetch }) => {
            const url = new URL('wasm/publicsuffixlist.wasm', import.meta.url);

            if ( customFetch !== null ) {
                const response = await customFetch(url);
                return WebAssembly.compile(await response.arrayBuffer());
            }

            return WebAssembly.compileStreaming(fetch(url));
        };

        const getWasmInstance = async ({ customFetch }) => {
            if ( typeof WebAssembly !== 'object' ) { return false; }
            // The wasm code will work only if CPU is natively little-endian,
            // as we use native uint32 array in our js code.
            const uint32s = new Uint32Array(1);
            const uint8s = new Uint8Array(uint32s.buffer);
            uint32s[0] = 1;
            if ( uint8s[0] !== 1 ) { return false; }

            try {
                const module = await wasmModuleFetcher({ customFetch });
                if (  module instanceof WebAssembly.Module === false ) {
                    return false;
                }
                const pageCount = this._pslBuffer8 !== null
                    ? this._pslBuffer8.byteLength + 0xFFFF >>> 16
                    : 1;
                const memory = new WebAssembly.Memory({ initial: pageCount });
                const instance = await WebAssembly.instantiate(module, {
                    imports: { memory }
                });
                if (  instance instanceof WebAssembly.Instance === false ) {
                    return false;
                }
                const curPageCount = memory.buffer.byteLength >>> 16;
                const newPageCount = this._pslBuffer8 !== null
                    ? this._pslBuffer8.byteLength + 0xFFFF >>> 16
                    : 0;
                if ( newPageCount > curPageCount ) {
                    memory.grow(newPageCount - curPageCount);
                }
                if ( this._pslBuffer32 !== null ) {
                    const buf8 = new Uint8Array(memory.buffer);
                    const buf32 = new Uint32Array(memory.buffer);
                    buf32.set(this._pslBuffer32);
                    this._pslBuffer8 = buf8;
                    this._pslBuffer32 = buf32;
                }
                this._wasmMemory = memory;
                this._getPublicSuffixPosWASM = instance.exports.getPublicSuffixPos;
                this._getPublicSuffixPos = this._getPublicSuffixPosWASM;
                return true;
            } catch(reason) {
                console.info(reason);
            }
            return false;
        };

        if ( this._wasmPromise === null ) {
            this._wasmPromise = getWasmInstance({ customFetch });
        }

        return this._wasmPromise;
    }

    async disableWASM() {
        let enabled = this._wasmPromise !== null ? await this._wasmPromise : false;

        this._getPublicSuffixPos = this._getPublicSuffixPosJS;
        this._getPublicSuffixPosWASM = null;

        if ( this._wasmMemory !== null ) {
            if ( this._pslBuffer32 !== null ) {
                const buf8 = new Uint8Array(this._pslByteLength);
                const buf32 = new Uint32Array(buf8.buffer);
                buf32.set(this._pslBuffer32);
                this._pslBuffer8 = buf8;
                this._pslBuffer32 = buf32;
            }
            this._wasmMemory = null;
        }

        this._wasmPromise = null;
        return enabled;
    }
}

/******************************************************************************/

export default new PublicSuffixList();

/******************************************************************************/
