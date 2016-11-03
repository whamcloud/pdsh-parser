// @flow

//
// INTEL CONFIDENTIAL
//
// Copyright 2013-2016 Intel Corporation All Rights Reserved.
//
// The source code contained or described herein and all documents related
// to the source code ("Material") are owned by Intel Corporation or its
// suppliers or licensors. Title to the Material remains with Intel Corporation
// or its suppliers and licensors. The Material contains trade secrets and
// proprietary and confidential information of Intel or its suppliers and
// licensors. The Material is protected by worldwide copyright and trade secret
// laws and treaty provisions. No part of the Material may be used, copied,
// reproduced, modified, published, uploaded, posted, transmitted, distributed,
// or disclosed in any way without Intel's prior express written permission.
//
// No license under any patent, copyright, trade secret or other intellectual
// property right is granted to or conferred upon you by disclosure or delivery
// of the Materials, either expressly, by implication, inducement, estoppel or
// otherwise. Any license under such intellectual property rights must be
// express and approved by Intel in writing.

import * as fp from 'intel-fp';
import * as obj from 'intel-obj';
import * as math from 'intel-math';

let errorCollection = {
  errors: []
};

let expansionCollection = {
  expansion: [],
  sections: [],
  expansionHash: {}
};
let hostnameCache = {};
let duplicates = [];
const validRangeRegex = /^[0-9]+(?:-[0-9]+)?$/;
const expressionRegex = /(\[.*?\])/g;

const constants = Object.freeze({
  OPEN_BRACE: '[',
  CLOSING_BRACE: ']',
  TOKEN_TO_REPLACE: '%s',
  RANGE_NOT_PROPER_FORMAT: 'Range is not in the proper format.',
  EXPRESSION_EMPTY: 'Expression cannot be empty.',
  EXPRESSION_INVALID: 'Expression is invalid',
  INDEX_OF: 'indexOf',
  LAST_INDEX_OF: 'lastIndexOf',
  INCONSISTENT_DIGITS: 'Number of digits must be consistent across padded entries',
  EXPRESSION_OVER_CAP: 'The hostlist cannot contain more than 50000 entries.',
  CAP: 50000
});

const isEmpty = fp.or([fp.eq(null), fp.eq(undefined), fp.eq('')]);
const isNotEmpty = fp.flow(isEmpty, fp.not);
const isTrue = fp.flow(fp.eq(true), fp.always);
const isFalse = fp.flow(fp.eq(false), fp.always);

/**
 * The pdshParser function returned to the client receives an expression to be parsed.
 * @param {String} expression The expression must be trimmed of white space.
 * @return {Array}
 */
export default (expression:string) => {
  initialize();

  switch (isEmpty(expression)) {
  case true:
    addErrorObject(constants.EXPRESSION_EMPTY);
    break;
  case false:
    parseExpression(expression);
    break;

  }

  return (errorCollection.errors.length > 0) ? errorCollection : expansionCollection;
};

/**
 * Initializes the service by clearning out any existing entries in the error and expansion
 * collections.
 */
function initialize () {
  errorCollection = {errors: []};
  expansionCollection = {expansion: [], sections: [], expansionHash: {}};
  hostnameCache = {};
  duplicates = [];
}

/**
 * Parses an expression
 * @param {String} expression
 */
function parseExpression (expression) {
  const isValid = isExpressionValid(expression);
  const allExpressions = splitExpressions(expression, isInsideBraces);
  const notAboveCap = isNotAboveCap(isValid, allExpressions);
  const validAndNotAboveCap = fp.and([isTrue(isValid), isTrue(notAboveCap)]);

  if (validAndNotAboveCap(allExpressions))
    parseExpressionIntoGroups(allExpressions);
}

/**
 * Parses the expression into groups
 * @param {Array} allExpressions Array of expressions
 */
function parseExpressionIntoGroups (allExpressions) {
  const expandExpressions = fp.flow(
    tokenize,
    expandComponents
  );
  const expansionGroups = allExpressions
    .reduce(combineSimilarExpressions, [])
    .map(x => expandExpressions(x))
    .reduce((prev, curGroup) => {
      prev.expansion[curGroup.expression] = curGroup.expansion;
      prev.sections[curGroup.expression] = curGroup.sections;

      return prev;
    }, {
      expansion: {},
      sections: {}
    });

  processExpandedGroups(expansionGroups);
}

/**
 * Processes the expanded groups by checking for duplicates and adding to the expansion collection
 * or error collection depending on results.
 * @param {Array} expansionGroups
 */
function processExpandedGroups (expansionGroups) {
  // Are there any duplicates? If so, add an error indicating which item is duplicated and from
  // which expression.

  const expandedExpressions = fp.unwrap(obj.values(expansionGroups.expansion));

  // If a dup was found, locate which expression it came from.
  fp.cond(
    [math.gt(0), fp.always(retrieveDupExpressionsAndAddErrorMessage)],
    [fp.True, fp.always(updateExpansionCollection)]
  )(duplicates.length)(expansionGroups, expandedExpressions, duplicates);
}

/**
 * Retrieves the expressions in which duplicate items exist and adds the error message.
 * @param {Object} expansionGroups
 * @param {Array} expandedExpressions
 * @param {Array} dups
 */
function retrieveDupExpressionsAndAddErrorMessage (expansionGroups, expandedExpressions, dups) {
  const dupHostname = dups[0];

  const firstExpression = Object.keys(expansionGroups.expansion).reduce(
    identifyDuplicateExpression(dupHostname, expansionGroups.expansion), '');

  const secondExpression = Object.keys(expansionGroups.expansion).reduce(
    identifyDuplicateExpression(dupHostname, expansionGroups.expansion, firstExpression), '');

  addErrorObject('Expression ' + secondExpression + ' matches previous expansion of ' +
    dupHostname + ' generated by ' + firstExpression);
}

/**
 * HOF used in a reduce to identify expressions in which a duplicate entry occurred.
 * @param {String} dupHostname
 * @param {Object} expansionGroups
 * @param {String} [matchingExpression]
 * @returns {String}
 */
function identifyDuplicateExpression (dupHostname, expansionGroups, matchingExpression) {
  return (match, curExpression) => {
    if (match === '' && (matchingExpression == null || curExpression !== matchingExpression) &&
      expansionGroups[curExpression].find(x => x === dupHostname))
      return curExpression;
    else
      return match;
  };
}

/**
 * Updates the expansion collection with the expanded list as well as the grouped sections.
 * @param {Object} expansionGroups
 * @param {Array} expandedExpressions
 */
function updateExpansionCollection (expansionGroups, expandedExpressions) {
  expansionCollection.expansion = expandedExpressions;
  expansionCollection.sections = fp.unwrap(obj.values(expansionGroups.sections));
  expansionCollection.expansionHash = hostnameCache;
}

/**
 * Verifies that the expression is valid
 * @param {String} expression
 * @returns {Boolean}
 */
function isExpressionValid (expression) {
  // The main thing we need to check for is that for every opening brace there
  // is a closing brace.
  const openingBraces = expression.match(/\[/g) || [];
  const closingBraces = expression.match(/\]/g) || [];
  const commaNotLastCharacter = expression.charAt(expression.length - 1) !== ',';

  const openingIndicies = getIndexArrayOfBraces(expression, '[');
  const closingIndicies = getIndexArrayOfBraces(expression, ']');

  const hasValidBraceOrder = openingIndicies.reduce((prev, current, index) => {
    return prev && current < closingIndicies[index];
  }, true);

  const isValid = openingBraces.length === closingBraces.length && commaNotLastCharacter && hasValidBraceOrder;

  fp.cond(
    [isFalse(isValid), addErrorObject],
    [fp.True, fp.noop]
  )(constants.EXPRESSION_INVALID);

  return isValid;
}

/**
 * Indicates if the hostlist is greater than cap.
 * @param {Boolean} isValid
 * @param {Array} allExpressions Array of all expressions
 * @returns {Boolean}
 */
function isNotAboveCap (isValid, allExpressions) {
  let notAboveCap = false;
  let totalEntries = 0;

  if (isValid) {
    totalEntries = getTotalEntries(allExpressions);
    notAboveCap = totalEntries <= constants.CAP;
  }

  const passesCheck = fp.and([isTrue(isValid), isFalse(notAboveCap), isFalse(isNaN(totalEntries))]);

  fp.cond(
    [passesCheck, fp.always(addErrorObject)],
    [fp.True, fp.always(fp.noop)]
  )()(constants.EXPRESSION_OVER_CAP);

  return notAboveCap;
}

/**
 * Calculates the number of entries that will be produced by the expression.
 * @param {Array} allExpressions Array of expressions
 * @return {Number}
 */
function getTotalEntries (allExpressions) {
  const ranges = [];
  let m;

  return allExpressions.reduce((prev, currentExpression) => {
    while ((m = expressionRegex.exec(currentExpression)) != null) {
      if (m.index === expressionRegex.lastIndex)
        expressionRegex.lastIndex += 1;

      ranges.push(m[0].slice(1, -1));
    }

    return prev + ranges.reduce((prev, currentRange) => {
      return prev * currentRange.split(',')
        .map(parseItemIntoTotalLength)
        .reduce(sum(fp.identity), 0);
    }, 1);
  }, 0);
}

/**
 * This method is intended to used by reduce. It examines each expression to see if any of the expressions can be
 * combined. If they can, the expression list wil be reduced into a combined list. One important note is that
 * expressions can only be combined if they have a range difference no greater than one.
 * @example
 * // returns ['hostname[5-7,10-12].iml[1-2].com']
 * ['hostname[5-7].iml.com[1-2]', 'hostname[10-12].iml[1-2].com'].reduce(combineSimilarExpressions)
 * @example
 * // returns ['hostname[5-7].iml[1-2].com', 'hostname[10-12].iml[2-3]']
 * ['hostname[5-7].iml[1-2].com', 'hostname[10-12].iml[2-3]'].reduce(combineSimilarExpressions)
 * @param {Array} prevExpressions
 * @param {String} curExpression
 * @returns {*}
 */
function combineSimilarExpressions (prevExpressions, curExpression) {
  prevExpressions = typeof prevExpressions === 'string' ? [prevExpressions] : prevExpressions;

  const updatedExpressions = prevExpressions
    .map(
      compareExpressions(curExpression)
    );

  if (fp.difference(updatedExpressions, prevExpressions).length === 0)
    updatedExpressions.push(curExpression);

  return updatedExpressions;
}

/**
 * HOF
 * Used by the mapping function, compares the current expression to each expression in an array. It attempts to
 * combine like ranges if there is at MOST one corresponding range section that is different. If ranges are
 * combined, the new mapping will reflect the combined result.
 * @example
 * // returns ['hostname[2,6,7,8,10].iml.com']
 * ['hostname[2,6,7].iml.com'].map(compareExpressions('hostname[8,10].iml.com');
 *
 * @param {String} curExpression
 * @returns {Function}
 */
function compareExpressions (curExpression) {
  /**
   * @param {String} expression The current expression
   * @returns {String} The updated expression if it can be combined; otherwise, it will return the original.
   */
  return function innerCompareExpressions (expression:string) {
    const simplifiedPrevExpression = expression.replace(expressionRegex, constants.TOKEN_TO_REPLACE);
    const simplifiedCurrentExpression = curExpression.replace(expressionRegex, constants.TOKEN_TO_REPLACE);
    const isPreviousExpression = fp.flow(fp.eq(simplifiedPrevExpression), fp.always);

    // Does the simplified expression match the current expression?
    return fp.cond(
      [isPreviousExpression(simplifiedCurrentExpression), fp.always(examineAndCombineRanges)],
      [fp.True, fp.always(fp.identity)]
    )()(expression, curExpression, simplifiedCurrentExpression);
  };
}

/**
 * Examines and combines the ranges together if appropriate
 * @param {String} prevExpression The previous expression
 * @param {String} curExpression The current expression
 * @param {String} simplifiedCurrentExpression The hostname with the ranges replaced with %s
 * @returns {*}
 */
function examineAndCombineRanges (prevExpression, curExpression, simplifiedCurrentExpression) {
  const prevRanges = getExpandedRangesFromRegex(prevExpression);
  const curRanges = getExpandedRangesFromRegex(curExpression);
  const isLessThan2 = fp.flow(math.lt(2), fp.always);

  // In order to combine ranges, both the previous and current ranges must contain at MOST
  // one corresponding value that is different. If there is more than one, it cannot be combined.
  // For example:
  // host[1,2].iml[1-3] and host[5-7].iml[1-3] can be combined to make host[1,2,5-7].iml[1-3]
  // but the following can NOT be combined:
  // host[1,2].iml[1-3] and host[5-7].iml[2-3]

  return fp.cond(
    [isLessThan2(fp.difference(prevRanges.expanded, curRanges.expanded).length),
      fp.always(updateExpressionBasedOnPrevAndCurrentRanges)],
    [fp.True, fp.always(fp.identity)]
  )()(prevExpression, simplifiedCurrentExpression, prevRanges.ranges, curRanges.ranges);
}

/**
 * Updates the expression based on the previous and current ranges.
 * @param {String} prevExpression
 * @param {String} simplifiedCurrentExpression
 * @param {Array} prevRanges
 * @param {Array} curRanges
 * @returns {*}
 */
function updateExpressionBasedOnPrevAndCurrentRanges (prevExpression, simplifiedCurrentExpression, prevRanges,
                                                      curRanges) {
  let updatedExpression = simplifiedCurrentExpression;

  for (let i = 0; i < prevRanges.length; i += 1) {
    const updatedExpressionFromPrevRange = replaceTokenWithText.bind(null, updatedExpression);
    const isPrevRange = fp.flow(fp.eq(prevRanges[i]), fp.always);

    updatedExpression = fp.cond(
      [fp.flow(isPrevRange(curRanges[i]), fp.not),
        fp.always(expandExpressionUsingPrevAndCurrentRanges)],
      [fp.True, fp.always(updatedExpressionFromPrevRange)]
    )()(prevRanges[i], curRanges[i], updatedExpression);
  }

  // combine the sections into a new string
  return updatedExpression;
}

/**
 * Expands the expression using the previous and current ranges.
 * @param {String} prevRange
 * @param {String} curRange
 * @param {String} updatedExpression
 * @returns {String}
 */
function expandExpressionUsingPrevAndCurrentRanges (prevRange:string, curRange:string, updatedExpression:string) {
  const prevRangeNumbers = prevRange.slice(1, -1);
  const curRangeNumbers = curRange.slice(1, -1);
  const combinedRange = `[${prevRangeNumbers},${curRangeNumbers}]`;
  return replaceTokenWithText(updatedExpression, combinedRange);
}

/**
 * Returns the ranges and expanded ranges for the given expression
 * @param {String} expression
 * @returns {{ranges: Array, expandedRanges: Array}}
 */
function getExpandedRangesFromRegex (expression:string) {
  let m:string;
  const ranges:string[] = [];
  const expanded:string[] = [];

  while ((m = expressionRegex.exec(expression)) != null) {
    if (m.index === expressionRegex.lastIndex)
      expressionRegex.lastIndex += 1;

    ranges.push(m[0]);
    expanded.push(expandRangesAsString(m[0]));
  }

  return {
    ranges,
    expanded
  };
}

/**
 * Takes a component and expands out the comma delimited string representation. For example:
 * @example
 * //returns ['hostname6.iml.com','hostname7.iml.com']
 * expandComponents(['hostname', '[6,7]', '.iml.com'])
 * @param {Array} components
 * @returns {Object}
 */
function expandComponents (components:string[]) {
  const ranges = [];
  const hostname = components.reduce(
    generateHostNameFormat.bind(null, ranges)
  );

  // Expand the ranges and save them in expandedRanges
  let expandedRanges = ranges.map(expandRanges);
  // Sort the expanded ranges
  const uniq = fp.uniqBy(fp.identity);
  expandedRanges = expandedRanges.map(x => uniq(x));
  const rangeGroups = expandedRanges.map(findRangeInList);

  return {
    expression: components.join(''),
    expansion: formatString(hostname, expandedRanges),
    sections: formatHostnameGroups(rangeGroups, hostname)
  };
}

/**
 * Returns an array of range group sections based on the hostname format
 * @example
 * // returns 'hostname6..7-9..11.iml.com
 * formatHostnameGroups([[6,7],[9,10,11]], 'hostname%s-%s.iml.com')
 * @param {Array} rangeGroups
 * @param {String} hostnameFormat
 */
function formatHostnameGroups (rangeGroups, hostnameFormat) {

  let hostnameGroups = [];
  const curGroup = rangeGroups.shift();

  if (Array.isArray(curGroup) && curGroup.length > 0)
    curGroup.forEach((curRange) => {
      let rangeString = fp.head(curRange);
      if (curRange.length > 1)
        rangeString += `..${curRange[curRange.length - 1]}`;

      const updatedHostname = replaceTextWithToken(rangeString, hostnameFormat, constants.TOKEN_TO_REPLACE);

      if (rangeGroups.length > 0)
        hostnameGroups = hostnameGroups.concat(formatHostnameGroups(rangeGroups, updatedHostname));
      else
        hostnameGroups.push(updatedHostname);
    });
  else
    hostnameGroups.push(hostnameFormat);

  return hostnameGroups;
}

/**
 * Receives a list of numbers in string format (due to prefixes) and returns the discovered
 * ranges.
 * @example
 * // returns [[7], [9,10,11]]
 * findRangeInList([7,9,10,11])
 * @param {Array} list A sorted list of numbers in string format (due to prefixes)
 * @returns {Array}
 */
function findRangeInList (list) {
  if (!Array.isArray(list) || list.length === 0)
    return [];

  // Put the first item in the range
  let curLocation = 0;
  let ranges = [];

  const range = [list[0]];
  const length = list.length;

  while (curLocation < length - 1)
    if (+list[curLocation + 1] === +range[range.length - 1] + 1) {
      range.push(list[curLocation + 1]);
      curLocation += 1;
    } else {
      // The next item is not a range. Recursively call findRangeInList with an array
      // starting at the next location
      const newList = list.slice(curLocation + 1);
      const subranges = findRangeInList(newList);
      ranges = ranges.concat(subranges);

      // Set current location to end of array
      curLocation = list.length - 1;
    }

  ranges.unshift(range);
  return ranges;
}

/**
 * Generates the host name format
 * @param {Array} ranges
 * @param {String} prev
 * @param {String} current
 * @returns {String}
 */
function generateHostNameFormat (ranges, prev:string, current:string) {
  const newVal = prev.concat(current);
  const filteredRanges = [prev, current].filter(range);

  // Concat the filtered ranges onto ranges
  [].push.apply(ranges, filteredRanges);
  // replace the ranges in newVal with a token
  return filteredRanges.reduce(
    replaceTextWithToken.bind(
      null,
      constants.TOKEN_TO_REPLACE
    ),
    newVal
  );
}

/**
 * Replaces a specified target with a token in the source string
 * @param {String} token
 * @param {String} source
 * @param {String} target
 * @returns {String}
 */
function replaceTextWithToken (token:string, source:string, target:string) {
  return source.replace(target, token);
}

/**
 * Replaces the %s in the source with the specified token.
 * @param {String} source
 * @param {String}token
 * @returns {String}
 */
function replaceTokenWithText (source:string, token:string) {
  return source.replace(constants.TOKEN_TO_REPLACE, token);
}

/**
 * Takes a hostname and an array of ranges and then generates a list of valid host names based on the
 * array of ranges passed in.
 * @param {String} hostname (hostname%s.iml.com)
 * @param {Array} ranges An array of arrays representing the ranges.
 * @param {Number} [id] The current id
 * @returns {Array}
 */
function formatString (hostname, ranges, id) {
  const curArrayId = (typeof id === 'number' ? id : 0);
  const serverList = [];
  const isGreaterThan0 = fp.flow(math.gt(0), fp.always);

  fp.cond(
    [isGreaterThan0(ranges.length), fp.always(formatCurrentRange)],
    [fp.True, fp.always(addHostnameToServerListAndCache)]
  )()(serverList, hostname, ranges, curArrayId);

  return serverList;
}

/**
 * Formats the current range
 * @param {Array} serverList
 * @param {String} hostname
 * @param {Array} ranges
 * @param {Number} curArrayId
 */
function formatCurrentRange (serverList, hostname, ranges, curArrayId) {
  const curArray = ranges[curArrayId];
  curArray.forEach(
    x => computeString(serverList, hostname, ranges, curArrayId, x)
  );
}

/**
 * Builds the host name string given the ranges
 * @param {Array} serverList
 * @param {String} hostname
 * @param {Array} ranges
 * @param {Number} curArrayId
 * @param {String} part
 */
function computeString (serverList, hostname, ranges, curArrayId, part) {
  const updatedHostName = replaceTokenWithText(hostname, part);

  /**
   * A predicate used to determine if more ranges should be processed or if an item needs to be added.
   * @param {Array} ranges
   * @param {Number} curArrayId
   * @returns {Function}
   */
  function predicate (ranges, curArrayId) {
    return function innerPredicate () {
      return moreRangesAvailable(ranges, curArrayId);
    };
  }

  fp.cond(
    [predicate(ranges, curArrayId), fp.always(processMoreRanges)],
    [fp.True, fp.always(fp.noop)]
  )()(updatedHostName, ranges, curArrayId, serverList);

  fp.cond(
    [fp.flow(predicate(ranges, curArrayId), fp.not), fp.always(addHostnameToServerListAndCache)],
    [fp.True, fp.always(fp.noop)]
  )()(serverList, updatedHostName);
}

function addHostnameToServerListAndCache (serverList, hostname) {
  addItemToArray(serverList, hostname);
  hostnameCache[hostname] = hostnameCache[hostname] ? hostnameCache[hostname] + 1 : 1;

  fp.cond(
    [fp.flow(x => hostnameCache[x], math.gt(1)), addDuplicate]
  )(hostname);
}

/**
 * Processes more ranges if more ranges exist
 * @param {String} updatedHostName
 * @param {Array} ranges
 * @param {Number} curArrayId
 * @param {Array} serverList
 */
function processMoreRanges (updatedHostName, ranges, curArrayId, serverList) {
  const formattedList = formatString(updatedHostName, ranges, curArrayId + 1);
  [].push.apply(serverList, formattedList);
}

/**
 * Adds an item to a specified array
 * @param {Array} list
 * @param {*} val
 */
function addItemToArray (list, val) {
  list.push(val);
}

/**
 * Adds a hostname to the list of duplicate items
 * @param {String} hostname
 */
function addDuplicate (hostname) {
  duplicates.push(hostname);
}

/**
 * Parses a range into an array.
 * @example
 * // returns [0, 1, 2, 3, 4, 5, 6, 7]
 * expandRanges('[0-4,7,5-6]')
 * @param {String} rangeComponent
 * @returns {Array}
 */
function expandRanges (rangeComponent:string) {
  // Sort the range string
  const sortedRangeComponent = sortRangeString(rangeComponent);

  // Remove the beginning and ending brackets
  return sortedRangeComponent
    .slice(1,-1)
    .split(',')
    .map(parseItem)
    .reduce(flattenArrayOfValues);
}

/**
 * Takes in a range string and does a basic sort
 * @example
 * // returns '[0-4,5-6,7]'
 * sortRangeString('[0-4,7,5-6]')
 * @param {String} rangeComponent
 * @returns {Array}
 */
function sortRangeString (rangeComponent:string) {
  const minMaxComponents = getMinMaxComponents(rangeComponent);

  minMaxComponents.sort(compare);

  // reduce the sorted array back to a string
  let sortedRangeString = minMaxComponents.reduce((prev, current) => {
    const rangeString = (current.min === current.max) ? current.minPrefix + current.min :
      current.minPrefix + current.min + '-' + current.maxPrefix + current.max;
    const separator = (prev === '') ? '' : ',';

    return prev + separator + rangeString;
  }, '');
  sortedRangeString = '[' + sortedRangeString + ']';

  // sort on the min/max values
  function compare (a, b) {
    // a < b
    if (a.max < b.min)
      return -1;
    if (a.min > b.max)
      return 1;
    return 0;
  }

  return sortedRangeString;
}

/**
 * Receives a range components and returns a list of min/max objects
 * @example
 * // returns [{min: 1, max: 10}, {min: 15, max: 15}]
 * getMinMaxComponents('[1-10,15]')
 * @param {String} rangeComponent
 * @returns {Array}
 */
function getMinMaxComponents (rangeComponent:string) {
  const componentToParse = (rangeComponent[0] === '[') ? rangeComponent.slice(1, -1) : rangeComponent;
  const components = componentToParse.split(',');

  // return an array of min/max items
  return components.map((component) => {
    const rangeComponents = component.split('-');
    let min, max;
    if (+rangeComponents[0] > +rangeComponents[rangeComponents.length - 1]) {
      min = rangeComponents[rangeComponents.length - 1];
      max = rangeComponents[0];
    } else {
      min = rangeComponents[0];
      max = rangeComponents[rangeComponents.length - 1];
    }

    return {
      min: +min,
      max: +max,
      minPrefix: getPrefix(min),
      maxPrefix: getPrefix(max)
    };
  });
}

/**
 * Parses a range string into a comma delimited representation of the range.
 * @example
 * // returns "[0,1,2,3,4,7,9]"
 * expandRanges('[0-4,7,9]')
 * @param {String} rangeComponent
 */
function expandRangesAsString (rangeComponent) {
  return '[' + expandRanges(rangeComponent).join(',') + ']';
}

/**
 * Parses an item and returns an array representation of the items
 * @example
 * // returns ['09', '10', '11']
 * parseItem('09-11')
 * @param {String} item
 * @returns {Array}
 */
function parseItem (item:string) {
  const isSanitized = isValidRange(item);
  const range = item.split('-');
  const isLength2 = fp.flow(x => x.length, fp.eq(2));
  const isSanitizedWithLengthOf2 = fp.and([isLength2, isTrue(isSanitized)]);

  const rangeValues = isSanitizedWithLengthOf2(range) ?
    generateRange(range) :
    range;

  if (!isSanitized)
    addErrorObject(constants.RANGE_NOT_PROPER_FORMAT);

  return rangeValues;
}

/**
 * Parses an item and returns the total length
 * @example
 * // returns 3
 * parseItemIntoTotalLength('09-11')
 * @param {String} rangeComponent
 * @returns {Number}
 */
const parseItemIntoTotalLength =  fp.cond(
    [isValidRange, countItemsInRange],
    [fp.True,  () => addErrorObject(constants.RANGE_NOT_PROPER_FORMAT)]
  );

/**
 * Counts the items in the range component
 * @param {String} rangeComponent
 * @returns {Number}
 */
function countItemsInRange (rangeComponent) {
  const minMaxComponents = getMinMaxComponents(rangeComponent);

  return minMaxComponents.reduce((prev, current) => {
    return prev + (+current.max) - (+current.min) + 1;
  }, 0);
}

/**
 * Generates an array containing all of the numbers specified in the range (inclusive)
 * @param {Array} range
 * @returns {Array}
 */
function generateRange (range:string[]) {
  // is there a prefix in the range?
  const first = range[0];
  const last = range[range.length - 1];
  const prefixBeginning = getPrefix(first);
  const prefixEnding = getPrefix(last);
  const valid = (first.length === last.length && prefixBeginning.length > 0) ||
    (prefixBeginning.length === 0 && prefixEnding.length === 0);

  if (valid) {
    return generatePrefixedRanges(range, prefixBeginning);
  } else {
    addInconsistentDigitsError(errorCollection.errors, constants);
    return [];
  }

}

/**
 * Generates prefixed ranges
 * @example
 * [01,05] => [01,02,03,04,05]
 * @param {Array} range
 * @param {String} prefix
 * @returns {Array}
 */
function generatePrefixedRanges (range:string[], prefix:string) {
  const start = +range[0];
  const end = +range[1] + 1;
  const out = [];

  for (let i = start; i < end; i++)
    out.push(i);


  return out
    .map(
      prefixString(prefix, range[0].length)
    );
}

/**
 * Adds the "prefixes don't match" message to the error collection
 * @param {Array} errors
 * @param {Object} constants
 */
function addInconsistentDigitsError (errors, constants) {
  if (!errors.find(x => x === constants.INCONSISTENT_DIGITS))
    addErrorObject(constants.INCONSISTENT_DIGITS);
}

/**
 * Retrieves the prefix given an item
 * @example
 * Given item = 001, the value returned would be "00"
 * @param {String} item
 * @returns {string}
 */
function getPrefix (item:string) {
  const asNum = +item;

  // If the number is 0 (ex. '000') then simply return the item
  if (asNum === 0)
    return item.substring(0, item.length - 1);

  return item.substring(0, item.indexOf(asNum.toString()));
}

/**
 * HOF that prefixes a specified item with the prefix passed in.
 * @param {String} prefix
 * @param {Number} numDigits The number of digits to use on the range
 * @returns {Function}
 */
function prefixString (prefix, numDigits) {
  /**
   * Prefixes the specified item with the prefix passed in above.
   * @param {Number} item
   * @returns {String}
   */
  return function innerPrefixString (item) {
    item = item + '';
    if (prefix === '')
      return item;

    const prefixesToAdd = numDigits - item.length;
    const prefixToUse = fp.times(
      fp.always(0),
      prefixesToAdd
    ).join('');

    return prefixToUse + item;
  };
}

/**
 * An expression may be comma delimited. We can identify expressions by looking for
 * commas. However, it's a bit more complicated than this. We need to identify comma's that
 * separate our expressions. For example:
 * @example
 * vbox[10,11-12,2-3,5],vbox.com
 * There are two expressions here:
 * 1. vbox[10,11-12,2-3,5]
 * 2. vbox.com
 * Therefore, we need to apply a simple rule: For every comma identified, it must not be
 * surrounded by brackets.
 * @param {String} expression
 * @param {Function} isInsideBraces
 * @returns {Array}
 */
function splitExpressions (expression, isInsideBraces) {
  const expressions = [];
  // Split the expression by commas
  const curLoc = expression.indexOf(',');
  // remove all white space
  expression = expression.replace(/ /g, '');

  const isNegative1 = fp.flow(fp.eq(-1), fp.always);
  return fp.cond(
    [isNegative1(curLoc), fp.always(addExpressionToExpressionList)],
    [fp.True, fp.always(lookForMoreExpressionsToSplit)]
  )()(expressions, expression, curLoc, isInsideBraces);
}

/**
 * Adds an expression to the expressions array and returns the expressions array
 * @param {Array} expressions
 * @param {String} expression
 * @returns {Array}
 */
function addExpressionToExpressionList (expressions, expression) {
  expressions.push(expression);
  return expressions;
}

/**
 * Looks for more expressions to split
 * @param {Array} expressions
 * @param {String} expression
 * @param {Number} curLoc
 * @param {Function} isInsideBraces
 * @returns {Array}
 */
function lookForMoreExpressionsToSplit (expressions, expression, curLoc, isInsideBraces) {
  let ruleApplied;
  const isLocationInsideBraces = fp.flow(
    x => isInsideBraces(expression, x),
    fp.always
  );

  while (curLoc !== -1 && !ruleApplied) {
    // Apply the rule at the current comma location
    ruleApplied = fp.cond(
      [isLocationInsideBraces(curLoc), fp.always(addSplitExpression)],
      [fp.True, fp.always(fp.always(false))]
    )()(expressions, expression, curLoc, isInsideBraces);

    curLoc = expression.indexOf(',', curLoc + 1);
  }

  // There may be a final expression like this: hostname[15,17].iml.com
  // In this case, there is no separation of expressions but the if check above would not evaluate to
  // true because there is a comma in this expression; it just isn't separating multiple expressions.
  // Therefore, we need to add this to the list of expressions because it is the final expression.
  const is0 = fp.flow(fp.eq(0), fp.always);
  const isGreaterThan0 = fp.flow(math.gt(0), fp.always);
  const hasNoSeparation = fp.and([is0(expressions.length), isGreaterThan0(expression.length)]);

  fp.cond(
    [hasNoSeparation, fp.always(addExpressionToExpressionList)],
    [fp.True, fp.always(fp.noop)]
  )()(expressions, expression);

  return expressions;
}

/**
 * Adds the split expression to the expressions array
 * @param {Array} expressions
 * @param {String} expression
 * @param {Number} curLoc
 * @param {Function} isInsideBraces
 * @returns {Boolean}
 */
function addSplitExpression (expressions, expression, curLoc, isInsideBraces) {
  expressions.push(expression.substring(0, curLoc));

  // call split expressions and concat the resulting array onto the expressions list
  [].push.apply(expressions, splitExpressions(expression.slice(curLoc + 1),
    isInsideBraces));

  return true;
}

/**
 * Indicates if the location specified is inside braces
 * @param {String} expression The expression
 * @param {Number} loc The subject location in the expression in which the rule is being applied
 * @returns {Boolean}
 */
function isInsideBraces (expression, loc) {
  // Check the left and right braces to determine if the location is between braces
  const leftSide = expression.substr(0, loc);
  const rightSide = expression.substr(loc + 1);

  const lastIndexOf = ''.lastIndexOf;
  const indexOf = ''.indexOf;

  return hasBrace(lastIndexOf.bind(leftSide)) && hasBrace(indexOf.bind(rightSide));
}

/**
 * HOF that checks if the the specified side has a brace according to the rules below:
 * 1. hasLeftBrace - Is there a brace to the left of this location in which an open brace is NOT closer in
 * distance, or is there no closing brace to the left at all?
 * 2. hasRightBrace - Is there a brace to the right of this location in which a closing brace is NOT closer in
 * distance, or is there no open brace to the right at all?
 * @param {fn} indexOf | lastIndexOf bound to string
 * @returns {Boolean}
 */
function hasBrace (fn:(x:string) => number) {
  const closestClosingBrace = fn(constants.CLOSING_BRACE);
  const closestOpeningBrace = fn(constants.OPEN_BRACE);

  return ((closestClosingBrace === -1 && closestOpeningBrace === -1) ||
    (closestOpeningBrace < closestClosingBrace));
}

/**
 * A recursive algorithm that splits the expression into components.
 * @param {String} expression
 * @returns {Array}
 */
function tokenize (expression) {
  const tokens = [];
  fp.cond(
    [isNotEmpty, fp.always(proceedWithTokenize)],
    [fp.True, fp.always(fp.noop)]
  )(expression)(tokens, expression);

  return tokens;
}

/**
 * Called by the tokenize method if the expression is not empty. This method checks
 * to see if the expression contains a range. If it doesn't, it calls processNonRanges;
 * otherwise, it calls addTokenToList.
 * @param {Array} tokens
 * @param {String} expression
 */
function proceedWithTokenize (tokens, expression) {
  fp.cond(
    [fp.flow(range, fp.not), fp.always(processNonRanges)],
    [fp.True, fp.always(addTokenToList(constants.CLOSING_BRACE, 1))]
  )(expression)(tokens, expression);
}

/**
 * Processes expressions without a range
 * @param {Array} tokens
 * @param {String} expression
 */
function processNonRanges (tokens, expression) {
  fp.cond(
    [() => rangeExists(expression), fp.always(addTokenToList(constants.OPEN_BRACE, 0))],
    [fp.True, fp.always(addItemToArray)]
  )()(tokens, expression);
}

/**
 * Adds a token to the tokens list
 * @param {String} key
 * @param {Number} addToIndex
 * @returns {Function}
 */
function addTokenToList (key:string, addToIndex:number) {
  return function innerAddTokenToList (tokens, expression) {
    // We've hit a range. Create an array of values.

    const index = expression.indexOf(key);
    tokens.push(expression.substring(0, index + addToIndex));
    [].push.apply(tokens, tokenize(expression.slice(index + addToIndex)));
  };
}

function getIndexArrayOfBraces (expression, brace) {
  const re = (brace === '[') ? /([\[])/g : /([\]])/g;
  const indicies = [];
  let m;

  while ((m = re.exec(expression)) != null) {
    if (m.index === re.lastIndex)
      re.lastIndex += 1;

    indicies.push(m.index);
  }

  return indicies;
}

/**x
 * HOF to be used as an argument to reduce. Give it a function that will be executed
 * on each item of the array during the reduction process.
 * @param {Function} fn
 * @returns {Function}
 */
function sum (fn) {
  return function innerSum (prev, current) {
    return prev + fn(current);
  };
}

/**
 * Adds an error message to the errors object
 * @param {String} msg
 */
function addErrorObject (msg:string) {
  if (!errorCollection.errors.find(x => x === msg, errorCollection.errors))
    errorCollection.errors.push(msg);
}

/**
 * Takes multiple arrays and flattens them into one
 * @param {Array} prev
 * @param {Array} current
 * @returns {Array}
 */
function flattenArrayOfValues (prev:string[], current:string[]) {
  return prev.concat(current);
}

/**
 * Predicate indicating if there are more ranges available
 * @param {Array} ranges
 * @param {Number} curArrayId
 * @returns {Boolean}
 */
function moreRangesAvailable (ranges, curArrayId:number) {
  return curArrayId + 1 < ranges.length;
}

/**
 * Runs a regular expression against a range string. ex. 6-10
 * @param {String} item
 * @returns {Boolean}
 */
function isValidRange (item:string) {
  return validRangeRegex.test(item);
}

/**
 * Checks if a range is present in an expression
 * @param {String} e The expression
 * @returns {Boolean}
 */
function rangeExists (e:string) {
  return e.indexOf(constants.OPEN_BRACE) > -1;
}

/**
 * Indicates if the first character in the expression is the start of a range
 * @param {String} e The expression passed in
 * @returns {Boolean}
 */
function range (e:string) {
  return e[0] === constants.OPEN_BRACE;
}
