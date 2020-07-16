/*
Author: Luca Scaringella
GitHub: LucaCode
Copyright(c) Luca Scaringella
 */

// Properties related to error domains cannot be serialized.
const unserializableErrorProperties = {
    domain: 1,
    domainEmitter: 1,
    domainThrown: 1
};

/**
 * Convert an error into a JSON-compatible type (but still can contain cycle structure)
 * which can later be hydrated back to its 'original' form.
 * @param error
 * @param includeStackTrace
 */
export function dehydrateError(error: any, includeStackTrace: boolean = false): any {
    if (error && typeof error === 'object') {
        const dehydratedError: any = {
            message: error.message
        };
        if (includeStackTrace) {
            dehydratedError.stack = error.stack;
        }
        for (const key in error) {
            if (!unserializableErrorProperties[key]) {
                dehydratedError[key] = error[key];
            }
        }
        return dehydratedError;
    } else if (typeof error === 'function') {
        return '[function ' + (error.name || 'anonymous') + ']';
    } else {
        return error;
    }
}

/**
 * Convert a dehydrated error back to its 'original' form.
 * @param error
 */
export function hydrateError(error): any {
    if (error != null) {
        if (typeof error === 'object') {
            const tmpError = new Error(error.message);
            for (const key in error) {
                if (error.hasOwnProperty(key)) {
                    tmpError[key] = error[key];
                }
            }
            return tmpError;
        }
        else {
            return error;
        }
    }
    return null;
}