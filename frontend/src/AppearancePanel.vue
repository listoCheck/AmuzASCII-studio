<script setup>
import {ref} from 'vue'
import {preferences,themes,chooseTheme,resetAppearance} from './preferences.js'
import {t,number} from './i18n.js'
const dialog=ref(null)
</script>
<template>
  <div class="header-preferences">
    <select v-model="preferences.locale" :aria-label="t('Язык')" class="language-select"><option value="ru">Русский</option><option value="en">English</option></select>
    <button class="appearance-trigger" @click="dialog.showModal()" :title="t('Персонализация')" :aria-label="t('Персонализация')">◐ <span>{{t('Оформление')}}</span></button>
  </div>
  <dialog ref="dialog" class="appearance-dialog" @click="event=>{if(event.target===dialog)dialog.close()}">
    <div class="dialog-heading"><div><h2>{{t('Персонализация')}}</h2><p>{{t('Настройте интерфейс под себя')}}</p></div><button @click="dialog.close()" :aria-label="t('Закрыть')">×</button></div>
    <label>{{t('Тема интерфейса')}}</label>
    <div class="theme-grid"><button v-for="theme in themes" :key="theme.id" :class="{active:preferences.theme===theme.id}" :aria-pressed="preferences.theme===theme.id" @click="chooseTheme(theme.id)"><span class="theme-preview" aria-hidden="true" :style="{background:theme.colors[0],color:theme.colors[2]}"><i :style="{background:theme.colors[1]}"></i><b>Aa</b><i :style="{background:theme.accent}"></i></span><span>{{t(theme.name)}}</span></button></div>
    <div class="appearance-options"><label>{{t('Акцентный цвет')}}<input type="color" v-model="preferences.accent"></label><label>{{t('Плотность интерфейса')}}<select id="ui-density" v-model="preferences.density"><option value="comfortable">{{t('Комфортная')}}</option><option value="compact">{{t('Компактная')}}</option></select></label></div>
    <label for="ui-font">{{t('Размер текста')}} <output>{{number(preferences.fontScale)}}%</output></label><input id="ui-font" type="range" min="90" max="120" step="5" v-model.number="preferences.fontScale">
    <label for="ui-panel">{{t('Ширина панели')}} <output>{{number(preferences.panelWidth)}} px</output></label><input id="ui-panel" type="range" min="280" max="440" step="10" v-model.number="preferences.panelWidth">
    <label for="ui-radius">{{t('Скругление')}} <output>{{number(preferences.radius)}} px</output></label><input id="ui-radius" type="range" min="0" max="18" v-model.number="preferences.radius">
    <label class="check"><span>{{t('Сетка рабочей области')}}</span><input type="checkbox" v-model="preferences.grid"></label>
    <p class="hint">{{t('Настройки оформления не меняют цвета ASCII-изображения.')}}</p>
    <div class="dialog-actions"><button @click="resetAppearance">{{t('Сбросить оформление')}}</button><button class="primary" @click="dialog.close()">{{t('Готово')}}</button></div>
  </dialog>
</template>
