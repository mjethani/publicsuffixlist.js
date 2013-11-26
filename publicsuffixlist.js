/*******************************************************************************

    httpswitchboard - a Chromium browser extension to black/white list requests.
    Copyright (C) 2013  Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/
*/

function PublicSuffixList() {
    this.exceptions = {};
    this.rules = {};
    // This value dictate how the search will be performed:
    //    < this.cutoffLength = indexOf()
    //   >= this.cutoffLength = binary search
    this.cutoffLength = 480;
    // var rawText = readLocalTextFile('assets/thirdparties/mxr.mozilla.org/effective_tld_names.dat');
}

/******************************************************************************/

PublicSuffixList.prototype.mustPunycode = /[^a-z0-9.-]/;

/******************************************************************************/

// Parse and set a UTF-8 text-based suffix list. Format is same as found at:
// http://publicsuffix.org/list/

PublicSuffixList.prototype.parse = function(text) {
    var exceptions = this.exceptions = {};
    var rules = this.rules = {};

    // First step is to find and categorize all suffixes.
    var lines = text.split('\n');
    var i = lines.length;
    var line, store, pos, tld;

    while ( i-- ) {
        line = lines[i];

        // Ignore comments
        beg = line.indexOf('//');
        if ( beg >= 0 ) {
            line = line.slice(0, beg);
        }

        // Ignore surrounding whitespaces
        line = line.trim();
        if ( !line ) {
            continue;
        }

        // http://publicsuffix.org/list/:
        // "... all rules must be canonicalized in the normal way
        // for hostnames - lower-case, Punycode ..."
        line = line.toLowerCase();

        if ( this.mustPunycode.test(line) ) {
            line = punycode.toASCII(line);
        }

        // Is this an exception rule?
        if ( line.charAt(0) === '!' ) {
            store = exceptions;
            line = line.slice(1);
        } else {
            store = rules;
        }

        // Extract TLD
        pos = line.lastIndexOf('.');
        if ( pos < 0 ) {
            tld = line;
        } else {
            tld = line.slice(pos + 1);
            line = line.slice(0, pos);
        }

        // Store suffix using tld as key
        if ( !store[tld] ) {
            store[tld] = [];
        }
        if ( line ) {
            store[tld].push(line);
        }
    }
    this.crystallize(exceptions);
    this.crystallize(rules);
};

/******************************************************************************/

// Check whether a string is a domain.

PublicSuffixList.prototype.isDomain = function(hostname) {
    return PublicSuffixList.getDomain(hostname) === hostname;
};

/******************************************************************************/

// In the context of this code, a domain is defined as a label prefixing
// a public suffix. A single standalone label is a public suffix as per:
// http://publicsuffix.org/list/
// "If no rules match, the prevailing rule is '*' "
// This means 'localhost' is not deemed a domain by this
// code, since according to the definition above, it would be
// evaluated as a public suffix. The caller is threfore responsible to
// decide how to further interpret such public suffix.

PublicSuffixList.prototype.getDomain = function(hostname) {
    // A hostname starting with a dot is not a valid hostname.
    if ( !hostname || hostname.charAt(0) === '.' ) {
        return '';
    }
    hostname = hostname.toLowerCase();
    var suffix = this.getPublicSuffix(hostname);
    if ( suffix === hostname ) {
        return '';
    }
    var pos = hostname.lastIndexOf('.', hostname.lastIndexOf('.', hostname.length - suffix.length) - 1);
    if ( pos <= 0 ) {
        return hostname;
    }
    return hostname.slice(pos + 1);
};

/******************************************************************************/

// Check whether a string is a public suffix. 

PublicSuffixList.prototype.isPublicSuffix = function(suffix) {
    return this.getPublicSuffix(suffix) === suffix;
};

/******************************************************************************/

// Return longest public suffix.

PublicSuffixList.prototype.getPublicSuffix = function(suffix) {
    if ( !suffix ) {
        return '';
    }
    // Since we slice down the suffix with each pass, the first match
    // is the longest, so no need to find all the matching rules.
    var pos;
    while ( true ) {
        pos = suffix.indexOf('.');
        if ( pos < 0 ) {
            break;
        }
        if ( this.search(this.exceptions, suffix) ) {
            return suffix.slice(pos + 1);
        }
        if ( this.search(this.rules, suffix) ) {
            return suffix;
        }
        if ( this.search(this.rules, '*' + suffix.slice(pos)) ) {
            return suffix;
        }
        suffix = suffix.slice(pos + 1);
    }
    return suffix;
};

/******************************************************************************/

// Look up a specific hostname.

PublicSuffixList.prototype.search = function(store, hostname) {
    // Extract TLD
    var pos = hostname.lastIndexOf('.');
    var tld, remainder;
    if ( pos < 0 ) {
        tld = hostname;
        remainder = hostname;
    } else {
        tld = hostname.slice(pos + 1);
        remainder = hostname.slice(0, pos);
    }
    var substore = store[tld];
    if ( !substore ) {
        return false;
    }
    // If substore is a string, use indexOf()
    if ( typeof substore === 'string' ) {
        return substore.indexOf(' ' + remainder + ' ') >= 0;
    }
    // It is an array: use binary search.
    var l = remainder.length;
    var haystack = substore[l];
    if ( !haystack ) {
	    return false;
    }
    var left = 0;
    var right = Math.floor(haystack.length / l + 0.5);
    var i;
    while ( left < right ) {
        i = left + right >> 1;
	    needle = haystack.substr( l * i, l );
	    if ( remainder < needle ) {
		    right = i;
	    } else if ( remainder > needle ) {
		    left = i + 1;
	    } else {
		    return true;
	    }
    }
    return false;
};

/******************************************************************************/

// Cristallize the storage of suffixes using optimal internal representation
// for future look up.

PublicSuffixList.prototype.crystallize = function(store) {
    var cutoffLength = this.cutoffLength;
    var suffixes, suffix, i, l;

    for ( var tld in store ) {
        if ( !store.hasOwnProperty(tld) ) {
            continue;
        }
        suffixes = store[tld].join(' ');
        // No suffix
        if ( !suffixes ) {
            store[tld] = '';
            continue;
        }
        // Concatenated list of suffixes less than cutoff length:
        //   Store as string, lookup using indexOf()
        if ( suffixes.length < cutoffLength ) {
            store[tld] = ' ' + suffixes + ' ';
            continue;
        }
        // Concatenated list of suffixes greater or equal to cutoff length
        //   Store as array keyed on suffix length, lookup using binary search.
        i = store[tld].length;
        suffixes = [];
        while ( i-- ) {
            suffix = store[tld][i];
            l = suffix.length;
            if ( !suffixes[l] ) {
                suffixes[l] = [];
            }
            suffixes[l].push(suffix);
        }
        l = suffixes.length;
        while ( l-- ) {
            if ( suffixes[l] ) {
                suffixes[l] = suffixes[l].sort().join('');
            }
        }
        store[tld] = suffixes;
    }
    return store;
};

