import _ from 'lodash';
import queryPart from './query_part';
import kbn from 'app/core/utils/kbn';

export default class InfluxQuery {
  target: any;
  selectModels: any[];
  queryBuilder: any;
  groupByParts: any;
  templateSrv: any;
  scopedVars: any;

  /** @ngInject */
  constructor(target, templateSrv?, scopedVars?) {
    this.target = target;
    this.templateSrv = templateSrv;
    this.scopedVars = scopedVars;

    target.policy = target.policy || 'default';
    target.resultFormat = target.resultFormat || 'time_series';
    target.orderByTime = target.orderByTime || 'ASC';
    target.tags = target.tags || [];
    target.groupBy = target.groupBy || [{ type: 'time', params: ['$__interval'] }, { type: 'fill', params: ['null'] }];
    target.select = target.select || [[{ type: 'field', params: ['value'] }, { type: 'mean', params: [] }]];

    if (target.policy === 'auto') {
      target.policy = 'default';
      if (typeof scopedVars !== 'undefined' && typeof scopedVars.autopolicy !== 'undefined') {
        target.policy = scopedVars.autopolicy.value;
        var interval = kbn.interval_to_seconds(scopedVars.autointerval.value);
        if (interval > kbn.interval_to_seconds(scopedVars.__interval.value)) {
          scopedVars.__interval = { value: kbn.secondsToHms(interval) };
          scopedVars.interval = scopedVars.__interval;
        }
      }
    }

    this.updateProjection();
  }

  updateProjection() {
    this.selectModels = _.map(this.target.select, (parts: any) => {
      return _.map(parts, queryPart.create);
    });
    this.groupByParts = _.map(this.target.groupBy, queryPart.create);
  }

  updatePersistedParts() {
    this.target.select = _.map(this.selectModels, selectParts => {
      return _.map(selectParts, (part: any) => {
        return { type: part.def.type, params: part.params };
      });
    });
  }

  hasGroupByTime() {
    return _.find(this.target.groupBy, (g: any) => g.type === 'time');
  }

  hasFill() {
    return _.find(this.target.groupBy, (g: any) => g.type === 'fill');
  }

  addGroupBy(value) {
    const stringParts = value.match(/^(\w+)\((.*)\)$/);
    const typePart = stringParts[1];
    const arg = stringParts[2];
    const partModel = queryPart.create({ type: typePart, params: [arg] });
    const partCount = this.target.groupBy.length;

    if (partCount === 0) {
      this.target.groupBy.push(partModel.part);
    } else if (typePart === 'time') {
      this.target.groupBy.splice(0, 0, partModel.part);
    } else if (typePart === 'tag') {
      if (this.target.groupBy[partCount - 1].type === 'fill') {
        this.target.groupBy.splice(partCount - 1, 0, partModel.part);
      } else {
        this.target.groupBy.push(partModel.part);
      }
    } else {
      this.target.groupBy.push(partModel.part);
    }

    this.updateProjection();
  }

  removeGroupByPart(part, index) {
    const categories = queryPart.getCategories();

    if (part.def.type === 'time') {
      // remove fill
      this.target.groupBy = _.filter(this.target.groupBy, (g: any) => g.type !== 'fill');
      // remove aggregations
      this.target.select = _.map(this.target.select, (s: any) => {
        return _.filter(s, (part: any) => {
          const partModel = queryPart.create(part);
          if (partModel.def.category === categories.Aggregations) {
            return false;
          }
          if (partModel.def.category === categories.Selectors) {
            return false;
          }
          return true;
        });
      });
    }

    this.target.groupBy.splice(index, 1);
    this.updateProjection();
  }

  removeSelect(index: number) {
    this.target.select.splice(index, 1);
    this.updateProjection();
  }

  removeSelectPart(selectParts, part) {
    // if we remove the field remove the whole statement
    if (part.def.type === 'field') {
      if (this.selectModels.length > 1) {
        const modelsIndex = _.indexOf(this.selectModels, selectParts);
        this.selectModels.splice(modelsIndex, 1);
      }
    } else {
      const partIndex = _.indexOf(selectParts, part);
      selectParts.splice(partIndex, 1);
    }

    this.updatePersistedParts();
  }

  addSelectPart(selectParts, type) {
    const partModel = queryPart.create({ type: type });
    partModel.def.addStrategy(selectParts, partModel, this);
    this.updatePersistedParts();
  }

  private renderTagCondition(tag, index, interpolate) {
    let str = '';
    let operator = tag.operator;
    let value = tag.value;
    if (index > 0) {
      str = (tag.condition || 'AND') + ' ';
    }

    if (!operator) {
      if (/^\/.*\/$/.test(value)) {
        operator = '=~';
      } else {
        operator = '=';
      }
    }

    // quote value unless regex
    if (operator !== '=~' && operator !== '!~') {
      if (interpolate) {
        value = this.templateSrv.replace(value, this.scopedVars);
      }
      if (operator !== '>' && operator !== '<') {
        value = "'" + value.replace(/\\/g, '\\\\') + "'";
      }
    } else if (interpolate) {
      value = this.templateSrv.replace(value, this.scopedVars, 'regex');
    }

    return str + '"' + tag.key + '" ' + operator + ' ' + value;
  }

  getMeasurementAndPolicy(interpolate) {
    let policy = this.target.policy;
    let measurement = this.target.measurement || 'measurement';

    if (!measurement.match('^/.*/$')) {
      measurement = '"' + measurement + '"';
    } else if (interpolate) {
      measurement = this.templateSrv.replace(measurement, this.scopedVars, 'regex');
    }

    if (policy !== 'default') {
      policy = '"' + this.target.policy + '".';
    } else {
      policy = '';
    }

    return policy + measurement;
  }

  interpolateQueryStr(value, variable, defaultFormatFn) {
    // if no multi or include all do not regexEscape
    if (!variable.multi && !variable.includeAll) {
      return value;
    }

    if (typeof value === 'string') {
      return kbn.regexEscape(value);
    }

    const escapedValues = _.map(value, kbn.regexEscape);
    return '(' + escapedValues.join('|') + ')';
  }

  render(interpolate?) {
    const target = this.target;

    if (target.rawQuery) {
      if (interpolate) {
        return this.templateSrv.replace(target.query, this.scopedVars, this.interpolateQueryStr);
      } else {
        return target.query;
      }
    }

    let query = 'SELECT ';
    let i, y;
    for (i = 0; i < this.selectModels.length; i++) {
      const parts = this.selectModels[i];
      let selectText = '';
      for (y = 0; y < parts.length; y++) {
        const part = parts[y];
        selectText = part.render(selectText);
      }

      if (i > 0) {
        query += ', ';
      }
      query += selectText;
    }

    query += ' FROM ' + this.getMeasurementAndPolicy(interpolate) + ' WHERE ';
    const conditions = _.map(target.tags, (tag, index) => {
      return this.renderTagCondition(tag, index, interpolate);
    });

    if (conditions.length > 0) {
      query += '(' + conditions.join(' ') + ') AND ';
    }

    query += '$timeFilter';

    let groupBySection = '';
    for (i = 0; i < this.groupByParts.length; i++) {
      const part = this.groupByParts[i];
      if (i > 0) {
        // for some reason fill has no separator
        groupBySection += part.def.type === 'fill' ? ' ' : ', ';
      }
      groupBySection += part.render('');
    }

    if (groupBySection.length) {
      query += ' GROUP BY ' + groupBySection;
    }

    if (target.fill) {
      query += ' fill(' + target.fill + ')';
    }

    if (target.orderByTime === 'DESC') {
      query += ' ORDER BY time DESC';
    }

    if (target.limit) {
      query += ' LIMIT ' + target.limit;
    }

    if (target.slimit) {
      query += ' SLIMIT ' + target.slimit;
    }

    if (target.tz) {
      query += " tz('" + target.tz + "')";
    }

    return query;
  }

  renderAdhocFilters(filters) {
    const conditions = _.map(filters, (tag, index) => {
      return this.renderTagCondition(tag, index, false);
    });
    return conditions.join(' ');
  }
}
