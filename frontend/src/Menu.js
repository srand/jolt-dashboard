import React from 'react';
import Metric from './Metric'

import { Outlet, NavLink } from "react-router-dom";

class Menu extends React.Component {
    constructor(props) {
        super(props);
    }

    render() {
        return (
            <div className="w3-cell-row jolt-tabs w3-border-bottom">
                <div>
                    <NavLink className={({ isActive }) => (isActive ? 'w3-cell jolt-tab--selected' : 'w3-cell jolt-tab')} to="/tasks">Tasks</NavLink>
                    <NavLink className={({ isActive }) => (isActive ? 'w3-cell jolt-tab--selected' : 'w3-cell jolt-tab')} to="/link2">Link</NavLink>
                </div>
            </div>
        )
    }
}

export default Menu;
